//! Per-project token-bucket rate limiter backed by Redis.
//!
//! The check-and-decrement runs inside a Lua script (`EVAL`) so it is atomic
//! across concurrent capture workers — no read/modify/write races.

use crate::state::AppState;

/// Atomic token bucket. State is stored in a Redis hash per project:
/// `{ tokens, ts }`. On each call we refill by elapsed time, then try to spend
/// one token. Returns `{allowed(0|1), retry_after_secs}`.
const BUCKET_SCRIPT: &str = r#"
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill   = tonumber(ARGV[2])   -- tokens per second
local now      = tonumber(ARGV[3])   -- milliseconds

local data   = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  ts     = now
end

local delta = math.max(0, now - ts) / 1000.0
tokens = math.min(capacity, tokens + delta * refill)

local allowed = 0
local retry_after = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_after = math.ceil((1 - tokens) / refill)
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- Expire idle buckets once they would be fully refilled anyway.
redis.call('PEXPIRE', key, math.ceil((capacity / refill) * 1000) + 1000)

return { allowed, retry_after }
"#;

/// Outcome of a rate-limit check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    /// Whether the request may proceed.
    pub allowed: bool,
    /// Seconds to wait before retrying (only meaningful when `!allowed`).
    pub retry_after: u64,
}

/// Consume one token for `project_id`. Never fails the request on Redis errors
/// in a fail-open manner — instead surfaces them so the caller decides; here we
/// map the error up so the handler returns 500 only on genuine backend faults.
pub async fn check(state: &AppState, project_id: &str) -> anyhow::Result<Decision> {
    let mut redis = state.redis.clone();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let key = format!("capture:rl:{project_id}");

    let (allowed, retry_after): (i64, i64) = redis::Script::new(BUCKET_SCRIPT)
        .key(key)
        .arg(state.config.rate_limit_burst)
        .arg(state.config.rate_limit_refill_per_sec)
        .arg(now_ms)
        .invoke_async(&mut redis)
        .await?;

    Ok(Decision {
        allowed: allowed == 1,
        retry_after: retry_after.max(0) as u64,
    })
}
