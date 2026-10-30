import {
  generateRefreshToken,
  hashPassword,
  hashRefreshToken,
  issueAccessToken,
  refreshTokenExpiresAt,
  refreshTokenSelector,
  verifyPassword,
  verifyRefreshToken,
} from '@clickroom/auth'
import {
  bootstrapOrg,
  newId,
  OrgDomainService,
  type Prisma,
  type PrismaClient,
  uniqueOrgSlug,
} from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { writeQuotaLimitsMirror } from '../lib/quota.cache.js'

// The control-plane auth layer runs BEFORE any org context exists, so it is the
// one place that talks to the UNSCOPED Prisma singleton and hand-writes
// user/session/org lookups (the scoped client + the biome tenant-scope rule only
// govern `ctx.db`/`ctx.prisma` inside routers — `this.prisma` here is exempt).

export interface AuthUser {
  id: string
  email: string
  name: string | null
}

export interface AuthOrg {
  id: string
  name: string
  slug: string
}

export interface AuthResult {
  accessToken: string
  refreshToken: string
  user: AuthUser
  org: AuthOrg | null
}

export interface ImpersonationResult extends AuthResult {
  // Surfaced so the caller (admin.impersonate.stop) doesn't need
  // to decode the access token's own claims just to recover this.
  sessionId: string
}

const IMPERSONATION_TTL_MS = 30 * 60 * 1000

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly jwtSecret: string,
  ) {}

  async signup(
    input: { email: string; password: string; orgName: string },
    // Runs first inside the signup transaction (e.g. the first-owner advisory lock).
    beforeCreate?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } })
    if (existing) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Email already in use.' })
    }

    const passwordHash = await hashPassword(input.password)

    const { user, org, limits } = await this.prisma.$transaction(async (tx) => {
      await beforeCreate?.(tx)
      const user = await tx.user.create({
        data: { id: newId(), email: input.email, passwordHash },
      })
      const slug = await uniqueOrgSlug(tx, input.orgName)
      const { org, limits } = await bootstrapOrg(tx, {
        orgName: input.orgName,
        slug,
        userId: user.id,
      })
      return { user, org, limits }
    })

    // Best-effort mirror for capture-rs's quota gate. Not part of
    // the transaction: a missed write just costs one extra Postgres fallback
    // query on capture-rs's next cache miss for this org, not correctness.
    // NOTE: re-wire this same call into any future plan/override-mutation
    // endpoint (23.C+) so the mirror never drifts from Postgres.
    await writeQuotaLimitsMirror(org.id, limits)

    const { accessToken, refreshToken } = await this.createSession(user.id, org.id)

    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name },
      org,
    }
  }

  async login(input: { email: string; password: string }): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } })
    if (!user) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid email or password.' })
    }

    // SSO-only (JIT-provisioned) accounts have no password — reject up front
    // rather than falling through to a confusing "invalid password" error.
    if (user.passwordHash == null) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'This account uses SSO.' })
    }

    // Enforcement breakglass: if the email's domain is verified for an org
    // whose SsoConnection is enforced, only that org's org_admin may still
    // password-login — everyone else must use SSO.
    const resolved = await new OrgDomainService(this.prisma).resolveOrgByEmailDomain(input.email)
    if (resolved?.connection?.enforced) {
      const membership = await this.prisma.orgMembership.findUnique({
        where: { orgId_userId: { orgId: resolved.org.id, userId: user.id } },
      })
      if (membership?.role !== 'org_admin') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Your organization requires SSO to sign in.',
        })
      }
    }

    const valid = await verifyPassword(user.passwordHash, input.password)
    if (!valid) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid email or password.' })
    }

    // MVP: a user belongs to a single org — resolve it for the token's orgId.
    const membership = await this.prisma.orgMembership.findFirst({
      where: { userId: user.id },
      include: { org: true },
      orderBy: { createdAt: 'asc' },
    })
    const org = membership
      ? { id: membership.org.id, name: membership.org.name, slug: membership.org.slug }
      : null

    const { accessToken, refreshToken } = await this.createSession(user.id, org?.id ?? null)

    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name },
      org,
    }
  }

  async refresh(rawRefreshToken: string): Promise<AuthResult> {
    const selector = refreshTokenSelector(rawRefreshToken)
    const session = await this.prisma.session.findFirst({
      where: { refreshTokenSelector: selector },
      include: { user: true },
    })

    if (
      !session ||
      session.expiresAt < new Date() ||
      (session.impersonationExpiresAt && session.impersonationExpiresAt < new Date())
    ) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Session expired.' })
    }

    const valid = await verifyRefreshToken(rawRefreshToken, session.refreshTokenHash)
    if (!valid) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Session expired.' })
    }

    // Rotate the refresh token; the active org survives the refresh. An
    // impersonated session's `expiresAt` is NOT pushed back out to the normal
    // long-lived TTL — it must still die at its original 30-minute cap
    // (`impersonationExpiresAt`), which the guard above already re-checks on
    // every refresh regardless.
    const newRefreshToken = generateRefreshToken()
    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        refreshTokenHash: await hashRefreshToken(newRefreshToken),
        refreshTokenSelector: refreshTokenSelector(newRefreshToken),
        expiresAt: session.impersonationExpiresAt ?? refreshTokenExpiresAt(),
      },
    })

    const accessToken = await issueAccessToken(
      { sub: session.userId, sessionId: session.id, orgId: session.activeOrgId },
      this.jwtSecret,
    )

    const org = session.activeOrgId
      ? await this.prisma.org.findUnique({ where: { id: session.activeOrgId } })
      : null

    return {
      accessToken,
      refreshToken: newRefreshToken,
      user: { id: session.user.id, email: session.user.email, name: session.user.name },
      org: org ? { id: org.id, name: org.name, slug: org.slug } : null,
    }
  }

  async getInvite(token: string): Promise<{ email: string; orgName: string; role: string }> {
    const invite = await this.prisma.orgInvite.findUnique({
      where: { token },
      include: { org: true },
    })
    if (!invite || invite.acceptedAt || invite.invalidatedAt || invite.expiresAt < new Date()) {
      // Uniform NOT_FOUND for missing/accepted/invalidated/expired — avoids
      // leaking which case applies (token enumeration).
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Invite not found.' })
    }
    return { email: invite.email, orgName: invite.org.name, role: invite.role }
  }

  async acceptInvite(input: {
    token: string
    name: string
    password: string
  }): Promise<AuthResult> {
    const invite = await this.prisma.orgInvite.findUnique({ where: { token: input.token } })
    if (!invite || invite.acceptedAt || invite.invalidatedAt || invite.expiresAt < new Date()) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Invite not found.' })
    }

    const existing = await this.prisma.user.findUnique({ where: { email: invite.email } })
    if (existing) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'An account with this email already exists — sign in instead.',
      })
    }

    const passwordHash = await hashPassword(input.password)

    const { user, org } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { id: newId(), email: invite.email, name: input.name, passwordHash },
      })
      await tx.orgMembership.create({
        data: { id: newId(), orgId: invite.orgId, userId: user.id, role: invite.role },
      })
      await tx.orgInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } })
      const org = await tx.org.findUniqueOrThrow({ where: { id: invite.orgId } })
      return { user, org }
    })

    const { accessToken, refreshToken } = await this.createSession(user.id, org.id)

    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name },
      org: { id: org.id, name: org.name, slug: org.slug },
    }
  }

  async signInViaSso(input: {
    userId: string
    orgId: string
    connectionId: string
  }): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({ where: { id: input.userId } })
    if (!user) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'User not found.' })
    }

    const membership = await this.prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId: input.orgId, userId: input.userId } },
      include: { org: true },
    })
    if (!membership) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of that organization.' })
    }

    const { accessToken, refreshToken } = await this.createSession(user.id, input.orgId, {
      authMethod: 'sso',
      ssoConnectionId: input.connectionId,
    })

    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name },
      org: { id: membership.org.id, name: membership.org.name, slug: membership.org.slug },
    }
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id: sessionId } })
  }

  async me(userId: string, orgId: string | null, sessionId?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' })

    const membership = orgId
      ? await this.prisma.orgMembership.findUnique({
          where: { orgId_userId: { orgId, userId } },
          include: { org: true },
        })
      : null

    // Surfaced so `apps/web` can render the impersonation banner
    // without a new endpoint (spec.
    const session = sessionId
      ? await this.prisma.session.findUnique({
          where: { id: sessionId },
          select: { impersonatedByAdminId: true, impersonationExpiresAt: true },
        })
      : null

    return {
      user: { id: user.id, email: user.email, name: user.name },
      org: membership
        ? { id: membership.org.id, name: membership.org.name, slug: membership.org.slug }
        : null,
      role: membership?.role ?? null,
      impersonatedByAdminId: session?.impersonatedByAdminId ?? null,
      impersonationExpiresAt: session?.impersonationExpiresAt ?? null,
    }
  }

  private async createSession(
    userId: string,
    orgId: string | null,
    sso?: { authMethod: string; ssoConnectionId: string },
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const refreshToken = generateRefreshToken()
    const session = await this.prisma.session.create({
      data: {
        id: newId(),
        userId,
        refreshTokenHash: await hashRefreshToken(refreshToken),
        refreshTokenSelector: refreshTokenSelector(refreshToken),
        activeOrgId: orgId,
        expiresAt: refreshTokenExpiresAt(),
        authMethod: sso?.authMethod,
        ssoConnectionId: sso?.ssoConnectionId,
      },
    })

    const accessToken = await issueAccessToken(
      { sub: userId, sessionId: session.id, orgId },
      this.jwtSecret,
    )

    return { accessToken, refreshToken }
  }

  /**
   * Mint a real tenant session attributed to an admin's
   * impersonation, not a synthetic bearer or a read-only render (: a
   * view-only mode cannot reproduce a bug in a write path). Flows through the
   * unmodified normal session/refresh machinery — nothing downstream needs to
   * special-case an impersonated request except attribution, which
   * `request-context.middleware.ts` derives from `impersonationExpiresAt`.
   *
   * `Session.expiresAt` (the refresh-token TTL) is also capped to the
   * 30-minute window, not just `impersonationExpiresAt`: the middleware check
   * already enforces the cap on every authenticated request, but capping
   * `expiresAt` too means `refresh()` independently rejects a stale
   * impersonated refresh token even if that check were ever bypassed.
   */
  async createImpersonatedSession(
    adminUserId: string,
    userId: string,
    orgId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ImpersonationResult> {
    const client = tx ?? this.prisma
    const user = await client.user.findUnique({ where: { id: userId } })
    if (!user) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found.' })
    }
    const membership = await client.orgMembership.findUnique({
      where: { orgId_userId: { orgId, userId } },
      include: { org: true },
    })
    if (!membership) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'User is not a member of that org.' })
    }

    const impersonationExpiresAt = new Date(Date.now() + IMPERSONATION_TTL_MS)
    const refreshToken = generateRefreshToken()
    const session = await client.session.create({
      data: {
        id: newId(),
        userId,
        refreshTokenHash: await hashRefreshToken(refreshToken),
        refreshTokenSelector: refreshTokenSelector(refreshToken),
        activeOrgId: orgId,
        expiresAt: impersonationExpiresAt,
        impersonatedByAdminId: adminUserId,
        impersonationExpiresAt,
      },
    })

    const accessToken = await issueAccessToken(
      { sub: userId, sessionId: session.id, orgId },
      this.jwtSecret,
    )

    return {
      accessToken,
      refreshToken,
      sessionId: session.id,
      user: { id: user.id, email: user.email, name: user.name },
      org: { id: membership.org.id, name: membership.org.name, slug: membership.org.slug },
    }
  }

  /*nd an impersonated session early (`admin.impersonate.stop`). */
  async stopImpersonatedSession(
    sessionId: string,
    adminUserId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    await (tx ?? this.prisma).session.deleteMany({
      where: { id: sessionId, impersonatedByAdminId: adminUserId },
    })
  }
}
