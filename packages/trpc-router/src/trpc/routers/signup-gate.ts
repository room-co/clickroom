import { isSelfHost, type PrismaClient, resolveSignupMode, type SignupMode } from '@clickroom/db'
import { evaluate, type Flag } from '@clickroom/sdk-js/eval'
import { TRPCError } from '@trpc/server'
import { cacheGetJson } from '../../lib/redis.js'
import { type FlagBlob, flagCacheKey } from './flags.cache.js'

/**
 * Server-side half of the pre-GA signup gate, ported from the reference implementation's
 * `apps/api/src/lib/signup-eligibility.ts`. The flag itself lives in the
 * dogfood org's project, exactly like the `internal-*` rollout flags the
 * dashboard reads through `apps/web/src/lib/use-internal-flag.ts`.
 *
 * `SignupPage` reads the same flag to render the closed notice, but that half is
 * cosmetic: `auth.signup` is a `publicProcedure`, so a browser-only gate is
 * bypassed by POSTing `/trpc/auth.signup` directly. This check is the one that
 * actually closes signups.
 *
 * Polarity is deliberately inverted versus the reference implementation's `signup-mode` (which serves
 * `open`/`request`/`disabled` and fails CLOSED). Here the flag is ON to CLOSE
 * signups, so every environment that has no dogfood org, no flag, or no Redis —
 * local dev, self-host, CI — resolves to "not gated" and account creation keeps
 * working. The trade-off is that a Redis outage or an accidentally deleted flag
 * fails OPEN. That is acceptable because this is a rollout throttle, not an
 * authorization boundary; nothing behind it is protected by it.
 */
export const SIGNUP_GATE_FLAG_KEY = 'internal-signups-gated'

/**
 * Org that owns the gate flag. `clickroom` in prod, `clickroom-dev` locally —
 * see `DOGFOOD_PROD_ORG_SLUG` / `DOGFOOD_DEV_ORG_SLUG` in
 * `packages/db/src/seed.dogfood.ts`, whose `DOGFOOD_MODE` picks between them.
 */
const dogfoodOrgSlug = (): string => process.env.DOGFOOD_ORG_SLUG || 'clickroom'

/** Kept in sync with `DOGFOOD_PROJECT_NAME` in `packages/db/src/seed.dogfood.ts`. */
const DOGFOOD_PROJECT_NAME = 'Platform'

/**
 * Env slug whose flag blob the gate reads. The dogfood write key the dashboard
 * evaluates against is minted in `production` (seed.dogfood.ts), so both halves
 * of the gate read the same env by default.
 */
const dogfoodFlagEnv = (): string => process.env.DOGFOOD_FLAG_ENV || 'production'

type GateTarget = { projectId: string; envKey: string }

/**
 * Resolving the dogfood project is a Postgres round-trip we do not want on every
 * signup, so it is memoized process-wide. A *successful* resolution is cached for
 * the life of the process (the dogfood project id never moves). A failed one is
 * re-tried after `NEGATIVE_TTL_MS` so an api booted before `seed:dogfood` ran
 * picks the flag up without a restart.
 */
const NEGATIVE_TTL_MS = 60_000
let cached: { target: GateTarget | null; expiresAt: number } | null = null

/** Test seam — drops the memoized dogfood project so cases can vary the fixture. */
export function resetSignupGateCache(): void {
  cached = null
}

async function lookupTarget(prisma: PrismaClient): Promise<GateTarget | null> {
  try {
    const org = await prisma.org.findUnique({
      where: { slug: dogfoodOrgSlug() },
      select: { id: true },
    })
    if (!org) return null

    const project = await prisma.project.findFirst({
      where: { orgId: org.id, name: DOGFOOD_PROJECT_NAME },
      select: { id: true },
    })
    if (!project) return null

    return { projectId: project.id, envKey: dogfoodFlagEnv() }
  } catch {
    // Fail open — see the polarity note on SIGNUP_GATE_FLAG_KEY.
    return null
  }
}

async function resolveTarget(prisma: PrismaClient): Promise<GateTarget | null> {
  if (cached && (cached.target !== null || cached.expiresAt > Date.now())) return cached.target
  const target = await lookupTarget(prisma)
  cached = { target, expiresAt: Date.now() + NEGATIVE_TTL_MS }
  return target
}

/**
 * Pull the gate flag out of the same Redis blob `capture`'s `/v1/flags` reads, so
 * a toggle in the dashboard reaches this check as soon as `rebuildFlagCache` runs
 * — no separate poll, no second definition of the flag.
 *
 * Falls back to Postgres when the blob is absent. That fallback is not
 * belt-and-braces, it is required: the blob carries a 24h TTL and is only
 * rewritten by `rebuildFlagCache` on a flag *write* (see flags.cache.ts), so a
 * dogfood project nobody has edited for a day has no blob at all. For an ordinary
 * feature flag a missing blob just means "feature off", which is harmless. For
 * this gate "off" means *signups reopen*, so a Redis-only read would silently
 * undo the gate a day after it was switched on.
 */
async function readGateFlag(prisma: PrismaClient, target: GateTarget): Promise<Flag | null> {
  const blob = await cacheGetJson<FlagBlob>(flagCacheKey(target.projectId, target.envKey))
  if (blob) {
    const entry = blob.flags.find((f) => f.key === SIGNUP_GATE_FLAG_KEY)
    if (!entry) return null
    return { key: entry.key, active: entry.active, filters: entry.filters as Flag['filters'] }
  }
  return readGateFlagFromDb(prisma, target)
}

/**
 * Cache-miss path: the flag's own row, via the `(projectId, key, environmentId)`
 * unique index. Only reached when Redis has no blob, so the hot path stays a
 * single Redis GET.
 */
async function readGateFlagFromDb(prisma: PrismaClient, target: GateTarget): Promise<Flag | null> {
  try {
    const row = await prisma.featureFlag.findFirst({
      where: {
        projectId: target.projectId,
        key: SIGNUP_GATE_FLAG_KEY,
        deletedAt: null,
        environment: { key: target.envKey },
      },
      select: { key: true, active: true, filters: true },
    })
    if (!row) return null
    return { key: row.key, active: row.active, filters: row.filters as Flag['filters'] }
  } catch {
    // Fail open — see the polarity note on SIGNUP_GATE_FLAG_KEY.
    return null
  }
}

/**
 * True when the flag closes signups for this email. The email is the
 * `distinct_id`, mirroring the reference implementation's `{ kind: 'user', key: email, email }`
 * context, so percentage rollouts bucket per-email and property filters on
 * `email` (e.g. `icontains @acme.co`) work as written in the dashboard.
 */
export async function isSignupGated(prisma: PrismaClient, email: string): Promise<boolean> {
  const target = await resolveTarget(prisma)
  if (!target) return false

  const flag = await readGateFlag(prisma, target)
  if (!flag) return false

  return evaluate(flag, email, { email }).enabled
}

const CLOSED_MESSAGE =
  'Public signups are not open yet. Ask for an invite to join an existing workspace.'

const forbidden = (message: string) => new TRPCError({ code: 'FORBIDDEN', message })

const OWNER_EXISTS_MESSAGE = 'This instance already has an owner. Ask an admin for an invite link.'

/** Arbitrary constant key for the first-owner advisory lock. */
const FIRST_OWNER_LOCK_KEY = 5_901_001

/**
 * Self-host signup policy (`SIGNUP_MODE`). `first_user_only` lets the
 * very first account through (it becomes the org owner via the normal bootstrap)
 * and is invite-only afterwards. This is the fast, non-atomic pre-check; the
 * authoritative one is `assertFirstOwnerInTx`, which runs inside the signup
 * transaction under an advisory lock.
 */
async function assertSelfHostSignupAllowed(prisma: PrismaClient): Promise<void> {
  const mode = resolveSignupMode()
  if (mode === 'open') return
  if (mode === 'closed') {
    throw forbidden('Signups are disabled on this instance. Ask an admin for an invite link.')
  }
  if ((await prisma.user.count()) > 0) {
    throw forbidden(OWNER_EXISTS_MESSAGE)
  }
}

type LockableTx = {
  $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => PromiseLike<number>
  user: { count: () => PromiseLike<number> }
}

/**
 * Race-free half of `first_user_only`. Call as the FIRST statement of the signup
 * transaction: it takes a transaction-scoped Postgres advisory lock (released on
 * commit/rollback) so concurrent first signups serialize, then re-counts users.
 * The loser blocks until the winner commits, sees its user row, and is rejected.
 * No-op outside self_host `first_user_only`.
 */
export async function assertFirstOwnerInTx(tx: LockableTx): Promise<void> {
  if (!isSelfHost() || resolveSignupMode() !== 'first_user_only') return
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FIRST_OWNER_LOCK_KEY})`
  if ((await tx.user.count()) > 0) throw forbidden(OWNER_EXISTS_MESSAGE)
}

/**
 * Throws FORBIDDEN when signup is closed for this email; returns silently
 * otherwise. `self_host` follows `SIGNUP_MODE`; `cloud` keeps the dogfood flag.
 */
export async function assertSignupsOpen(prisma: PrismaClient, email: string): Promise<void> {
  if (isSelfHost()) return assertSelfHostSignupAllowed(prisma)
  if (!(await isSignupGated(prisma, email))) return
  throw forbidden(CLOSED_MESSAGE)
}

export interface SignupStatus {
  deployment: 'self_host' | 'cloud'
  /** Self-host only: the configured `SIGNUP_MODE`. */
  mode: SignupMode | null
  /** True when the next signup would create the instance's owner account. */
  ownerSetup: boolean
}

/** Public, cosmetic status for the sign-up screen ("Create the owner account"). */
export async function getSignupStatus(prisma: PrismaClient): Promise<SignupStatus> {
  if (!isSelfHost()) return { deployment: 'cloud', mode: null, ownerSetup: false }
  const mode = resolveSignupMode()
  const ownerSetup = mode === 'first_user_only' && (await prisma.user.count()) === 0
  return { deployment: 'self_host', mode, ownerSetup }
}
