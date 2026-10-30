// Load the monorepo-root .env into process.env BEFORE anything that reads it
// (notably the `@clickroom/db` Prisma singleton, which builds its pg adapter
// from `DATABASE_URL` at import time). Hand-parsed to avoid a direct dotenv
// dependency (not hoisted under pnpm's strict layout). Shell-exported vars win
// over the .env file, so explicit overrides still take precedence.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEV_ADMIN_JWT_SECRET,
  DEV_JWT_SECRET,
  DEV_MCP_OAUTH_STATE_SECRET,
  DEV_SSO_RELAY_STATE_SECRET,
  isDevLikeEnv,
  resolveSecret,
} from '@clickroom/auth'
import type { AdminPasswordSink, Deployment, SignupMode } from '@clickroom/db'

function loadRootEnv(): void {
  const path = fileURLToPath(new URL('../../../.env', import.meta.url))
  try {
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      // Do not clobber vars already set in the process (shell exports win).
      if (process.env[key] === undefined) process.env[key] = value
    }
  } catch {
    // No .env — downstream code fails fast on the missing DATABASE_URL.
  }
}

// ── SSO env vars ────────────────────────────────────────────────
// Dev boots with sane, hardcoded-but-obviously-fake defaults so `make up` /
// `pnpm dev` work with zero manual setup. In production these are real
// secrets with no safe default, so we fail fast at boot with a clear error
// instead of letting the app silently run with a placeholder (or crash later,
// deep inside crypto code, with a confusing message).
const SSO_SECRETS_KEY_BYTES = 32

function decodeSsoSecretsKey(value: string): Buffer {
  return /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64')
}

function ensureSsoEnv(): void {
  const isProd = !isDevLikeEnv()

  process.env.SSO_RELAY_STATE_SECRET = resolveSecret(
    'SSO_RELAY_STATE_SECRET',
    DEV_SSO_RELAY_STATE_SECRET,
  )

  if (!process.env.SSO_SECRETS_KEY) {
    if (isProd) {
      throw new Error(
        'SSO_SECRETS_KEY is required in production (base64 or hex encoding of a ' +
          `${SSO_SECRETS_KEY_BYTES}-byte key for the SSO secrets envelope)`,
      )
    }
    // Deterministic dev-only key (32 zero bytes, hex-encoded) — never used in prod.
    process.env.SSO_SECRETS_KEY = '0'.repeat(SSO_SECRETS_KEY_BYTES * 2)
  } else {
    const buf = decodeSsoSecretsKey(process.env.SSO_SECRETS_KEY)
    if (buf.length !== SSO_SECRETS_KEY_BYTES) {
      const message = `SSO_SECRETS_KEY must decode to ${SSO_SECRETS_KEY_BYTES} bytes (got ${buf.length}); expected base64 or hex encoding of a ${SSO_SECRETS_KEY_BYTES}-byte key`
      if (isProd) throw new Error(message)
      // In dev, warn instead of hard-failing so a typo doesn't block the whole
      // app from booting — the lazy getter in packages/auth/src/secrets.ts will
      // still throw the same error at first actual use.
      console.warn(`[env] ${message}`)
    }
  }
}

// ── AI env vars ─────────────────────────────────────────────────
// `AI_ENCRYPTION_KEY` is the aes-256-gcm key for org AI provider API keys.
// `getEncryptionKey()` in packages/ai/src/crypto.ts does `Buffer.from(key, 'hex')`,
// which SILENTLY TRUNCATES at the first non-hex character rather than throwing — so a
// malformed key (a stray newline from a bad secret copy, a base64 value, a truncated
// paste) yields a short Buffer and surfaces as `Invalid key length` deep inside
// createCipheriv at the *first encrypt*. In prod that means the first customer to
// configure an AI provider, long after the deploy that broke it. Validate at boot so a
// bad key can never reach a running task.
//
// Strict hex only — no base64 fallback, unlike SSO_SECRETS_KEY, because crypto.ts
// unconditionally decodes as hex.
const AI_ENCRYPTION_KEY_BYTES = 32
const AI_ENCRYPTION_KEY_HEX = new RegExp(`^[0-9a-fA-F]{${AI_ENCRYPTION_KEY_BYTES * 2}}$`)

function ensureAiEnv(): void {
  const isProd = !isDevLikeEnv()

  if (!process.env.AI_ENCRYPTION_KEY) {
    if (isProd) {
      throw new Error(
        `AI_ENCRYPTION_KEY is required in production (hex encoding of a ${AI_ENCRYPTION_KEY_BYTES}-byte aes-256-gcm key for org AI provider API keys)`,
      )
    }
    // Deterministic dev-only key (32 zero bytes, hex-encoded) — never used in prod.
    process.env.AI_ENCRYPTION_KEY = '0'.repeat(AI_ENCRYPTION_KEY_BYTES * 2)
    return
  }

  if (!AI_ENCRYPTION_KEY_HEX.test(process.env.AI_ENCRYPTION_KEY)) {
    const message = `AI_ENCRYPTION_KEY must be exactly ${AI_ENCRYPTION_KEY_BYTES * 2} hex characters (a ${AI_ENCRYPTION_KEY_BYTES}-byte key); got ${process.env.AI_ENCRYPTION_KEY.length} characters`
    if (isProd) throw new Error(message)
    // In dev, warn rather than block the whole app from booting — crypto.ts still
    // throws at first actual use.
    console.warn(`[env] ${message}`)
  }
}

// ── Deployment mode ─────────────────────────────────────────────
// `CLICKROOM_DEPLOYMENT` is resolved ONCE here into a typed config; the db and
// router packages read the same env through `@clickroom/db`'s `deployment.ts`
// helpers (they cannot import from apps/api). Validation lives in this file only
// at boot so a typo (e.g. `SIGNUP_MODE=opne`) fails fast instead of silently
// degrading to a permissive default.
//
// Secrets the api consumes with committed dev-literal fallbacks elsewhere
// (`JWT_SECRET ?? 'dev-only-change-me'`, `ADMIN_JWT_SECRET`, MCP OAuth state,
// internal query bearer). A self_host production boot must NEVER reach those
// fallbacks, so it refuses to start without them. `scripts/install.sh`
// generates them. Cloud keeps its existing behaviour.
const SELF_HOST_REQUIRED_SECRETS = [
  'JWT_SECRET',
  'ADMIN_JWT_SECRET',
  'MCP_OAUTH_STATE_SECRET',
  'INTERNAL_QUERY_SECRET',
] as const

export interface ApiSecrets {
  jwt: string
  adminJwt: string
  mcpOAuthState: string
}

export interface ApiConfig {
  secrets: ApiSecrets
  deployment: Deployment
  signupMode: SignupMode
  adminPasswordSink: AdminPasswordSink
}

export function resolveApiConfig(
  env: Record<string, string | undefined> = process.env,
  isProd: boolean = env.NODE_ENV === 'production',
): ApiConfig {
  const pickEnum = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const raw = env[name]?.trim()
    if (!raw) return fallback
    if ((allowed as readonly string[]).includes(raw)) return raw as T
    throw new Error(`${name} must be one of ${allowed.join(' | ')} (got "${raw}")`)
  }
  const deployment = pickEnum<Deployment>(
    'CLICKROOM_DEPLOYMENT',
    ['self_host', 'cloud'],
    'self_host',
  )
  const signupMode = pickEnum<SignupMode>(
    'SIGNUP_MODE',
    ['open', 'first_user_only', 'closed'],
    'first_user_only',
  )
  const adminPasswordSink = pickEnum<AdminPasswordSink>(
    'ADMIN_PASSWORD_SINK',
    ['ssm', 'stdout', 'env'],
    deployment === 'cloud' ? 'ssm' : 'stdout',
  )

  // Fail closed in ANY deployment: the three signing secrets have dev literals, which are only
  // usable when NODE_ENV is development/test (resolveSecret throws otherwise — including when
  // NODE_ENV is unset or a typo of "production").
  const secrets: ApiSecrets = {
    jwt: resolveSecret('JWT_SECRET', DEV_JWT_SECRET, env),
    adminJwt: resolveSecret('ADMIN_JWT_SECRET', DEV_ADMIN_JWT_SECRET, env),
    mcpOAuthState: resolveSecret('MCP_OAUTH_STATE_SECRET', DEV_MCP_OAUTH_STATE_SECRET, env),
  }

  if (deployment === 'self_host' && isProd) {
    const missing = SELF_HOST_REQUIRED_SECRETS.filter((name) => !env[name])
    if (missing.length > 0) {
      throw new Error(
        `Missing required secret(s) for a production self_host boot: ${missing.join(', ')}. ` +
          'Refusing to fall back to development defaults. Generate them with deploy/selfhost/install.sh ' +
          '(or `openssl rand -hex 32`).',
      )
    }
  }
  return { secrets, deployment, signupMode, adminPasswordSink }
}

loadRootEnv()
export const config: ApiConfig = resolveApiConfig()
// Publish the resolved secrets so the `@clickroom/trpc-router` readers (which resolve through the
// same fail-closed helper) agree with the values apps/api signs with.
process.env.JWT_SECRET = config.secrets.jwt
process.env.ADMIN_JWT_SECRET = config.secrets.adminJwt
process.env.MCP_OAUTH_STATE_SECRET = config.secrets.mcpOAuthState
ensureSsoEnv()
ensureAiEnv()
