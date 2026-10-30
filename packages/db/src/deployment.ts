// Deployment mode, resolved from env in ONE place.
//
// `CLICKROOM_DEPLOYMENT=self_host|cloud` (default `self_host`) is the single
// switch for hosted-vs-self-host behaviour. Everything else (quota limits,
// entitlements, signup policy, admin-password sink) derives from the helpers
// here rather than scattering `if (isCloud)` checks. Helpers read
// `process.env` on every call (cheap) so tests can flip the mode per case;
// `apps/api/src/env.ts` validates the values once at boot and fails fast.

export type Deployment = 'self_host' | 'cloud'
export type SignupMode = 'open' | 'first_user_only' | 'closed'
export type AdminPasswordSink = 'ssm' | 'stdout' | 'env'

const DEPLOYMENTS: readonly Deployment[] = ['self_host', 'cloud']
const SIGNUP_MODES: readonly SignupMode[] = ['open', 'first_user_only', 'closed']
const SINKS: readonly AdminPasswordSink[] = ['ssm', 'stdout', 'env']

type Env = Record<string, string | undefined>

function pick<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = raw?.trim()
  if (!value) return fallback
  if ((allowed as readonly string[]).includes(value)) return value as T
  // Unknown values must not silently degrade to a permissive default.
  throw new Error(`${name} must be one of ${allowed.join(' | ')} (got "${value}")`)
}

export function resolveDeployment(env: Env = process.env): Deployment {
  return pick('CLICKROOM_DEPLOYMENT', env.CLICKROOM_DEPLOYMENT, DEPLOYMENTS, 'self_host')
}

export function isSelfHost(env: Env = process.env): boolean {
  return resolveDeployment(env) === 'self_host'
}

/** Only meaningful in `self_host`; cloud keeps the dogfood-flag gate. */
export function resolveSignupMode(env: Env = process.env): SignupMode {
  return pick('SIGNUP_MODE', env.SIGNUP_MODE, SIGNUP_MODES, 'first_user_only')
}

/** `ssm` for cloud, `stdout` for self_host unless `ADMIN_PASSWORD_SINK` says otherwise. */
export function resolveAdminPasswordSink(env: Env = process.env): AdminPasswordSink {
  const fallback: AdminPasswordSink = resolveDeployment(env) === 'cloud' ? 'ssm' : 'stdout'
  return pick('ADMIN_PASSWORD_SINK', env.ADMIN_PASSWORD_SINK, SINKS, fallback)
}
