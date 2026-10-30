import { Redis } from 'ioredis'

// Reuse a single ioredis connection across hot reloads in dev (mirrors the
// @clickroom/db Prisma singleton). ingest-rs (Rust) owns the taxonomy rows and
// the `tax:seen:<project_id>` discovery guard — the api only reads/writes its
// own `tax:def:<project_id>` cache, so the two never collide.
const globalForRedis = globalThis as unknown as {
  redis?: Redis
}

/**
 * Resolve the Redis connection URL: a literal `REDIS_URL` (local dev, CI, the
 * docker-compose stack) wins when set.
 *
 * The ECS task definitions inject `REDIS_HOST`/`REDIS_PORT`/`REDIS_TLS` as env and
 * `REDIS_AUTH_TOKEN` from Secrets Manager, never a composed `REDIS_URL` — the Rust
 * services read the same discrete vars. Without this branch the api silently dialled
 * `localhost:6380` in prod: every cache read missed (swallowed by cacheGetJson) and the
 * `/ready` probe's `redis.ping()` failed, so no api task ever passed the ALB health check.
 *
 * ElastiCache runs with transit encryption and an auth token, so the composed URL must be
 * `rediss://` with the token as the password.
 */
export function resolveRedisUrl(env: NodeJS.ProcessEnv = process.env): string {
  const literal = env.REDIS_URL
  if (literal) return literal

  const host = env.REDIS_HOST
  if (!host) return 'redis://localhost:6380'

  const scheme = env.REDIS_TLS === 'true' ? 'rediss' : 'redis'
  const port = env.REDIS_PORT ?? '6379'
  const token = env.REDIS_AUTH_TOKEN
  const auth = token ? `:${encodeURIComponent(token)}@` : ''
  return `${scheme}://${auth}${host}:${port}`
}

function createRedis(): Redis {
  const url = resolveRedisUrl()
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    // Fail fast instead of buffering commands when Redis is unreachable — the
    // cache helpers below swallow the rejection and fall through to Postgres.
    // NOT lazyConnect: combined with enableOfflineQueue:false, a lazy connect
    // races the very first command against the handshake — that command
    // rejects instead of queuing, and a cache *write* failing this way is
    // silently swallowed by cacheSetJson, freezing the Redis blob at whatever
    // was cached before this process started until its 24h TTL expires.
    // Connecting eagerly at construction avoids that race in practice.
    enableOfflineQueue: false,
  })
  // Prevent an unhandled 'error' event from crashing the process when Redis is
  // down; the cache layer degrades to a Postgres-only path.
  client.on('error', () => {})
  return client
}

export const redis: Redis = globalForRedis.redis ?? createRedis()

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis
}

/**
 * Read a JSON value from the cache. Any Redis failure (unreachable, timeout)
 * resolves to `null` so callers treat it as a cache miss and hit Postgres.
 */
export async function cacheGetJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

/** Write a JSON value with a TTL (seconds). Failures are swallowed. */
export async function cacheSetJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds)
  } catch {
    // Best-effort cache; a failed write just means the next read re-queries PG.
  }
}

/** Delete a cache key. Failures are swallowed. */
export async function cacheBust(key: string): Promise<void> {
  try {
    await redis.del(key)
  } catch {
    // Best-effort invalidation; the short TTL bounds any staleness on failure.
  }
}
