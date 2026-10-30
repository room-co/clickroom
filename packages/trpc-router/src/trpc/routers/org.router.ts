import { encryptApiKey } from '@clickroom/ai'
import { generateRefreshToken } from '@clickroom/auth'
import { effectiveLimits, newId, prisma } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { assertUnderQuota } from '../../lib/quota.guard.js'
import { orgScopedProcedure, requirePermission, router } from '../trpc.js'

const aiProviderSchema = z.enum(['anthropic', 'openai', 'google'])

// Mirrors OrgAISettings from @clickroom/ai, minus the encrypted key material
// (never round-tripped through this shape — see getAISettings).
type AISettings = {
  provider?: 'anthropic' | 'openai' | 'google'
  model?: string
  api_key_encrypted?: string
}

function readAISettings(org: { ai_settings: unknown }): AISettings {
  return (org.ai_settings ?? {}) as AISettings
}

const orgRoleSchema = z.enum(['org_admin', 'member', 'viewer'])

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const membersRouter = router({
  // Any org member may view the roster.
  list: orgScopedProcedure.query(({ ctx }) =>
    ctx.db.orgMembership.findMany({
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ),

  // Admin-only: the invite row's `token` is a bearer credential for joining
  // the org at the invited role, so this must never be readable by a
  // non-admin member (would let a low-privilege member self-elevate by
  // completing signup with someone else's pending invite token). The token
  // itself is deliberately excluded from the selected fields — the only
  // place a link is ever shown is the one-time result of `invite`.
  pendingInvites: requirePermission('members:manage').query(({ ctx }) =>
    ctx.db.orgInvite.findMany({
      where: { acceptedAt: null, invalidatedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, email: true, role: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  ),

  // Generates a token-based invite link (ported from the reference implementation).
  // MVP: no email delivery — the caller copies the returned link and shares it
  // manually. Single-org MVP: an email already tied to any org is rejected.
  invite: requirePermission('members:manage')
    .input(z.object({ email: z.string().email(), role: orgRoleSchema }))
    .mutation(async ({ input, ctx }) => {
      const existingUser = await ctx.db.user.findUnique({ where: { email: input.email } })
      if (existingUser) {
        // Deliberately unscoped: single-org MVP must check membership across
        // ALL orgs, not just the caller's — ctx.db auto-filters orgMembership
        // to ctx.orgId, which would silently miss a membership in another org.
        const existingMembership = await prisma.orgMembership.findFirst({
          where: { userId: existingUser.id },
        })
        if (existingMembership) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'That email is already a member of an org.',
          })
        }
      }

      const org = await ctx.db.org.findFirst({ include: { plan: true } })
      const seatCount =
        (await ctx.db.orgMembership.count()) +
        (await ctx.db.orgInvite.count({
          where: { acceptedAt: null, invalidatedAt: null, expiresAt: { gt: new Date() } },
        }))
      assertUnderQuota('seats', seatCount, effectiveLimits(org ?? {}, org?.plan ?? null).maxSeats)

      // Re-inviting the same email force-expires any prior pending invite —
      // the implicit resend/replace mechanism (no separate resend endpoint).
      await ctx.db.orgInvite.updateMany({
        where: { email: input.email, acceptedAt: null },
        data: { expiresAt: new Date() },
      })

      const token = generateRefreshToken()
      await ctx.db.orgInvite.create({
        data: {
          id: newId(),
          orgId: ctx.orgId,
          email: input.email,
          role: input.role,
          token,
          invitedBy: ctx.tokenPayload.sub,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      })
      return { token, email: input.email }
    }),

  revokeInvite: requirePermission('members:manage')
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const invite = await ctx.db.orgInvite.findFirst({ where: { id: input.id } })
      if (!invite) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Invite not found.' })
      }
      await ctx.db.orgInvite.updateMany({
        where: { id: input.id },
        data: { invalidatedAt: new Date() },
      })
      return { ok: true }
    }),

  setRole: requirePermission('members:manage')
    .input(z.object({ userId: z.string(), role: orgRoleSchema }))
    .mutation(async ({ input, ctx }) => {
      const target = await ctx.db.orgMembership.findFirst({ where: { userId: input.userId } })
      if (!target) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Membership not found.' })
      }
      // Guard against orphaning the org: never demote the last remaining admin.
      if (target.role === 'org_admin' && input.role !== 'org_admin') {
        const admins = await ctx.db.orgMembership.findMany({ where: { role: 'org_admin' } })
        if (admins.length <= 1) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot demote the last admin.' })
        }
      }
      await ctx.db.orgMembership.updateMany({
        where: { userId: input.userId },
        data: { role: input.role },
      })
      return { ok: true }
    }),

  remove: requirePermission('members:manage')
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const target = await ctx.db.orgMembership.findFirst({ where: { userId: input.userId } })
      if (!target) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Membership not found.' })
      }
      if (target.role === 'org_admin') {
        const admins = await ctx.db.orgMembership.findMany({ where: { role: 'org_admin' } })
        if (admins.length <= 1) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot remove the last admin.' })
        }
      }
      await ctx.db.orgMembership.deleteMany({ where: { userId: input.userId } })
      return { ok: true }
    }),
})

export const orgRouter = router({
  // Any org member may read the org.
  get: orgScopedProcedure.query(({ ctx }) => ctx.db.org.findFirst()),

  update: requirePermission('org:update')
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      await ctx.db.org.update({ where: { id: ctx.orgId }, data: { name: input.name } })
      return { ok: true }
    }),

  // BYO-key AI settings. Gated org:update like `update` above
  // — no separate read-level permission exists yet (packages/auth's Permission
  // enum), and the spec calls for non-admins to not see this at all, so the web
  // UI hides the section client-side rather than exposing a read-only view.
  setAISettings: requirePermission('org:update')
    .input(
      z.object({
        provider: aiProviderSchema,
        model: z.string().min(1),
        apiKey: z.string().min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const settings: AISettings = {
        provider: input.provider,
        model: input.model,
        api_key_encrypted: encryptApiKey(input.apiKey),
      }
      await ctx.db.org.update({ where: { id: ctx.orgId }, data: { ai_settings: settings } })
      return { ok: true }
    }),

  getAISettings: requirePermission('org:update').query(async ({ ctx }) => {
    const org = await ctx.db.org.findFirst()
    const settings = readAISettings(org ?? { ai_settings: {} })
    return {
      provider: settings.provider,
      model: settings.model,
      has_api_key: Boolean(settings.api_key_encrypted),
    }
  }),

  // Any org member (not just admins) needs this — it gates the Ask AI chat
  // surface itself (409 `ai_not_configured` check), which every
  // member uses, not only whoever configured the key.
  isAIConfigured: orgScopedProcedure.query(async ({ ctx }) => {
    const org = await ctx.db.org.findFirst({ select: { ai_settings: true } })
    return Boolean(readAISettings(org ?? { ai_settings: {} }).api_key_encrypted)
  }),

  // Clears just the encrypted key material, keeping provider/model — so
  // reconnecting a key preserves the org's prior provider/model choice
  // instead of resetting the picker to its defaults.
  clearAISettings: requirePermission('org:update').mutation(async ({ ctx }) => {
    const org = await ctx.db.org.findFirst()
    const settings = readAISettings(org ?? { ai_settings: {} })
    const cleared: AISettings = { provider: settings.provider, model: settings.model }
    await ctx.db.org.update({ where: { id: ctx.orgId }, data: { ai_settings: cleared } })
    return { ok: true }
  }),

  members: membersRouter,
})
