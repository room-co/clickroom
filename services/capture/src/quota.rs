//! Monthly usage quotas (org-scoped): events sent + feature-flag evaluations.
//!
//! Two Redis structures back this module:
//!   - `usage:limits:<org_id>` — a hash
//!     `{maxEventsPerMonth, maxFlagCallsPerMonth, overagePolicy}` mirrored by
//!     `apps/api` on org bootstrap and on any plan/override/policy change
//!     (`writeQuotaLimitsMirror` / `flags.cache.ts`'s rebuild-after-write
//!     pattern). `overagePolicy` is `"block"` or `"allow"` — an
//!     org's explicit choice of what happens once it's over its monthly
//!     limit. Read-miss here falls back to Postgres (`Org` join `Plan`), the
//!     same GET-miss-fallback shape as `auth.rs`'s `resolve_key`.
//!   - `usage:<metric>:<org_id>:<YYYYMM>` — a monthly counter checked and
//!     conditionally incremented atomically via a Lua script (modeled on
//!     `ratelimit.rs`'s token-bucket script), `metric` ∈ `events`|`flags`.
//!     `YYYYMM` is derived from the request timestamp in Rust (UTC) — never
//!     from Redis `TIME` — so the window boundary is deterministic and
//!     testable. The counter only ever moves by the true accepted amount: a
//!     batch that is actually rejected leaves it completely unchanged, so
//!     retries of a rejected batch never inflate it.
//!
//! `QUOTA_ENFORCE` (`config.rs`) gates the reject decision only: whenever a
//! batch is *not* actually rejected (enforce off, under the limit, or an
//! `allow`-overage org past its limit) counting still happens, so the usage
//! dashboard and a later flip back to enforce-on both see accurate
//! numbers.

use chrono::{DateTime, Utc};

use crate::state::AppState;

/// Counters roll over on a calendar-month boundary; a Redis TTL comfortably
/// past the longest possible month (31 days) means a counter self-heals even
/// if `apps/api`'s mirror write is ever missed, without lingering into the
/// month after next.
const COUNTER_TTL_MS: i64 = 40 * 24 * 60 * 60 * 1000;

/// TTL on the `usage:limits:<org_id>` mirror. `apps/api` rewrites it on every
/// plan/override/policy change, so this is purely a self-heal bound: a hash
/// written from a bad resolve (or left behind by a missed rewrite) expires
/// instead of living forever.
const LIMITS_TTL_SECS: i64 = 300;

/// The metric a call to [`check_events`]/[`check_flags`] is counting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Metric {
    Events,
    /// Only constructed by [`check_flags`].
    Flags,
}

impl Metric {
    fn as_str(self) -> &'static str {
        match self {
            Metric::Events => "events",
            Metric::Flags => "flags",
        }
    }
}

/// An org's explicit choice of what happens once it's over its
/// current-month limit for a metered metric. Scoped to events + flag-evals
/// only — seats and flags-created (lifetime caps) stay hard-block and
/// never consult this.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OveragePolicy {
    /// Today's (earlier) behavior: reject once over limit (subject to
    /// `QUOTA_ENFORCE`, as always).
    Block,
    /// The org opted in to accept-with-overage: over-limit traffic still
    /// proceeds (and is still counted), so usage exceeds the limit
    /// organically in ClickHouse. No invoicing happens here.
    Allow,
}

impl OveragePolicy {
    /// Parses the Redis/Postgres string form. Unknown or missing values
    /// fail closed to `Block` — mirrors this module's existing "no
    /// plan/org means no allowance" fail-closed stance for limits.
    fn from_str_lenient(s: &str) -> Self {
        match s {
            "allow" => OveragePolicy::Allow,
            _ => OveragePolicy::Block,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            OveragePolicy::Block => "block",
            OveragePolicy::Allow => "allow",
        }
    }
}

/// Outcome of a quota check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuotaDecision {
    /// Whether the request may proceed:
    /// `!enforce || !over || policy == Allow`. Callers do not need to
    /// re-check `QUOTA_ENFORCE` or re-read the org's policy themselves.
    pub allowed: bool,
    /// The counter's true total for this org+metric+month. Only actually
    /// moves by `n` when the batch was committed (i.e. when `allowed` is
    /// true) — a rejected batch leaves this at its pre-call value, so a
    /// rejected/retried batch never inflates the usage-dashboard-facing
    /// count.
    pub current: i64,
    /// The effective limit this decision was checked against.
    pub limit: i64,
    /// `current + n > limit` (the pre-commit would-be total) — the true
    /// over-limit signal, independent of both `QUOTA_ENFORCE` and the org's
    /// overage policy. This is what `allowed` would have been earlier
    /// (before enforce/policy gating).
    pub over: bool,
    /// The org's overage policy this decision was gated against, so the
    /// caller (the call sites) doesn't need to re-read it.
    pub policy: OveragePolicy,
}

/// The two monthly limits mirrored from Postgres (`Plan` + `Org` overrides),
/// plus the org's overage policy (plain passthrough of `Org`, no
/// plan-derived counterpart).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct QuotaLimits {
    max_events_per_month: i64,
    max_flag_calls_per_month: i64,
    overage_policy: OveragePolicy,
}

/// Check-then-conditionally-`INCRBY key n`; `PEXPIRE` only when the key did
/// not already exist (first write in the window).
///
/// The counter is only mutated when the batch will actually be *allowed to
/// proceed* — computed with the exact same formula [`apply_policy_gate`] uses
/// in Rust (`!enforce || !over || policy == Allow`), so the two never
/// diverge:
///   - under the limit: always committed (the common case).
///   - over the limit but `QUOTA_ENFORCE` is off, or the org's overage
///     policy is `allow`: still committed — these batches proceed and must
///     still be counted (see module docs: "counting always happens" /
///     "over-limit traffic still proceeds (and is still counted)").
///   - over the limit, enforce on, policy `block`: the batch is rejected, so
///     the counter is left completely UNCHANGED (not incremented at all, not
///     partially incremented) — a rejected/retried batch must never inflate
///     the usage-dashboard-facing count.
///
/// Mirrors `ratelimit.rs:11-42`'s `redis::Script::new(...).invoke_async`
/// pattern: atomic, no read/modify/write race across concurrent workers.
const COUNTER_SCRIPT: &str = r#"
local key          = KEYS[1]
local n            = tonumber(ARGV[1])
local limit        = tonumber(ARGV[2])
local ttl_ms       = tonumber(ARGV[3])
local enforce      = tonumber(ARGV[4])
local policy_allow = tonumber(ARGV[5])

local existed  = redis.call('EXISTS', key) == 1
local before   = existed and tonumber(redis.call('GET', key)) or 0
local would_be = before + n

local over = 0
if would_be > limit then
  over = 1
end

-- Same formula as `apply_policy_gate`: allowed = !enforce || !over || policy == allow.
local allowed = 1
if enforce == 1 and over == 1 and policy_allow == 0 then
  allowed = 0
end

local current = before
if allowed == 1 then
  current = redis.call('INCRBY', key, n)
  if not existed then
    redis.call('PEXPIRE', key, ttl_ms)
  end
end

return { over, current, limit }
"#;

/// The raw outcome of [`COUNTER_SCRIPT`]: the true over/under-limit signal
/// plus the counter state. `current` reflects the *true accepted* count —
/// unchanged from before the call when the batch was rejected, incremented
/// by `n` when it was committed. [`check`] turns this into a
/// [`QuotaDecision`] via [`apply_policy_gate`], which recomputes `allowed`
/// with the identical formula the Lua script used to decide whether to
/// commit, so the two never disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RawCount {
    /// `before + n > limit` — true regardless of whether the increment was
    /// actually committed.
    over: bool,
    current: i64,
    limit: i64,
}

/// Run [`COUNTER_SCRIPT`] for `key`: atomically check whether incrementing by
/// `n` would cross `limit`, and only commit the `INCRBY` when the batch will
/// actually be allowed to proceed (`enforce`/`policy_allow` decide that for
/// the over-limit case; under-limit batches always commit). Split out from
/// [`check`] so it can be unit-tested against a real Redis without needing a
/// full `AppState` (Postgres pool, JetStream, etc.).
async fn increment_and_check(
    redis: &mut redis::aio::ConnectionManager,
    key: &str,
    n: i64,
    limit: i64,
    enforce: bool,
    policy_allow: bool,
) -> anyhow::Result<RawCount> {
    let (over, current, limit): (i64, i64, i64) = redis::Script::new(COUNTER_SCRIPT)
        .key(key)
        .arg(n)
        .arg(limit)
        .arg(COUNTER_TTL_MS)
        .arg(enforce as i64)
        .arg(policy_allow as i64)
        .invoke_async(redis)
        .await?;

    Ok(RawCount {
        over: over == 1,
        current,
        limit,
    })
}

/// Turn a [`RawCount`] into the final [`QuotaDecision`] by applying both the
/// `QUOTA_ENFORCE` kill-switch and the org's overage policy:
/// `allowed = !enforce || !over || policy == Allow`. This is the exact same
/// formula [`COUNTER_SCRIPT`] used (via the `enforce`/`policy_allow` args
/// passed into [`increment_and_check`]) to decide whether to commit the
/// increment, so `allowed` here always agrees with whether `raw.current`
/// actually moved.
fn apply_policy_gate(raw: RawCount, enforce: bool, policy: OveragePolicy) -> QuotaDecision {
    QuotaDecision {
        allowed: !enforce || !raw.over || policy == OveragePolicy::Allow,
        current: raw.current,
        limit: raw.limit,
        over: raw.over,
        policy,
    }
}

/// Resolve the effective monthly limits for `org_id`: Redis hash
/// `usage:limits:<org_id>` first, Postgres (`Org` join `Plan`, override wins)
/// on a miss — same shape as `auth.rs`'s `resolve_key`. A miss also
/// repopulates the Redis hash so the fallback is self-healing.
async fn get_limits(state: &AppState, org_id: &str) -> anyhow::Result<QuotaLimits> {
    let cache_key = format!("usage:limits:{org_id}");
    let mut redis = state.redis.clone();

    // 1. Cache lookup.
    let (cached_events, cached_flags, cached_policy): (
        Option<String>,
        Option<String>,
        Option<String>,
    ) = redis::cmd("HMGET")
        .arg(&cache_key)
        .arg("maxEventsPerMonth")
        .arg("maxFlagCallsPerMonth")
        .arg("overagePolicy")
        .query_async(&mut redis)
        .await?;

    if let (Some(events), Some(flags)) = (&cached_events, &cached_flags) {
        if let (Ok(max_events_per_month), Ok(max_flag_calls_per_month)) =
            (events.parse::<i64>(), flags.parse::<i64>())
        {
            // A cached `0` is never real — no plan sells zero events or zero
            // flag calls, so it can only be the fail-closed sentinel of a
            // failed Postgres resolve that got mirrored. Treating it as a
            // cache *miss* (rather than cached truth) keeps a poisoned mirror
            // from permanently hard-blocking an org's ingest: the Postgres
            // path below re-resolves and rewrites the hash.
            if max_events_per_month > 0 && max_flag_calls_per_month > 0 {
                // `overagePolicy` may be absent on a hash written earlier
                // landed — fail closed to `Block` rather than treat it as a full
                // cache miss (`from_str_lenient` already does this for an
                // unrecognized string; `None` gets the same default here).
                let overage_policy = cached_policy
                    .as_deref()
                    .map(OveragePolicy::from_str_lenient)
                    .unwrap_or(OveragePolicy::Block);
                return Ok(QuotaLimits {
                    max_events_per_month,
                    max_flag_calls_per_month,
                    overage_policy,
                });
            }
        }
        // Malformed cache entry (shouldn't happen) — fall through to Postgres.
    }

    // 2. Postgres fallback: override ?? plan value ?? 0 (fail-closed — no
    // plan/org means no allowance, mirrors `packages/db/src/limits.ts`).
    // `(events_override, flags_override, plan_events, plan_flags, overage_policy)`.
    type LimitsRow = (
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<String>,
    );
    let row: Option<LimitsRow> = sqlx::query_as(
        r#"SELECT o."maxEventsPerMonthOverride", o."maxFlagCallsPerMonthOverride",
                  p."maxEventsPerMonth", p."maxFlagCallsPerMonth",
                  o."overagePolicy"::text
           FROM "Org" o
           LEFT JOIN "Plan" p ON p.id = o."planId"
           WHERE o.id = $1"#,
    )
    .bind(org_id)
    .fetch_optional(&state.pg)
    .await?;

    let (events_override, flags_override, plan_events, plan_flags, policy_str) =
        row.unwrap_or((None, None, None, None, None));
    let limits = QuotaLimits {
        max_events_per_month: events_override.or(plan_events).unwrap_or(0),
        max_flag_calls_per_month: flags_override.or(plan_flags).unwrap_or(0),
        // No org row (or no policy) => fail closed, same stance as the limits above.
        overage_policy: policy_str
            .as_deref()
            .map(OveragePolicy::from_str_lenient)
            .unwrap_or(OveragePolicy::Block),
    };

    // Repopulate the mirror so the next lookup is a cache hit again. The TTL
    // keeps the mirror from outliving the Postgres state it was derived from:
    // a stale (or fail-closed) hash self-heals within `LIMITS_TTL_SECS` even
    // if `apps/api`'s rewrite-on-change is ever missed.
    let _: () = redis::pipe()
        .cmd("HSET")
        .arg(&cache_key)
        .arg("maxEventsPerMonth")
        .arg(limits.max_events_per_month)
        .arg("maxFlagCallsPerMonth")
        .arg(limits.max_flag_calls_per_month)
        .arg("overagePolicy")
        .arg(limits.overage_policy.as_str())
        .cmd("EXPIRE")
        .arg(&cache_key)
        .arg(LIMITS_TTL_SECS)
        .query_async(&mut redis)
        .await?;

    Ok(limits)
}

/// Shared check: resolve limits, derive the `YYYYMM` window from `now`
/// (UTC — never Redis `TIME`), increment the monthly counter, and apply the
/// `QUOTA_ENFORCE` gate.
async fn check(
    state: &AppState,
    org_id: &str,
    metric: Metric,
    n: i64,
    now: DateTime<Utc>,
) -> anyhow::Result<QuotaDecision> {
    let limits = get_limits(state, org_id).await?;
    let limit = match metric {
        Metric::Events => limits.max_events_per_month,
        Metric::Flags => limits.max_flag_calls_per_month,
    };

    let yyyymm = now.format("%Y%m");
    let key = format!("usage:{}:{org_id}:{yyyymm}", metric.as_str());

    let enforce = state.config.quota_enforce;
    let policy_allow = limits.overage_policy == OveragePolicy::Allow;

    let mut redis = state.redis.clone();
    let raw = increment_and_check(&mut redis, &key, n, limit, enforce, policy_allow).await?;
    Ok(apply_policy_gate(raw, enforce, limits.overage_policy))
}

/// Count `n` events against `org_id`'s current-month event quota. Call sites
/// (`capture.rs`) increment by the validated batch size, after auth +
/// rate-limit, and reject the whole batch with `402` when `!decision.allowed`.
pub async fn check_events(state: &AppState, org_id: &str, n: i64) -> anyhow::Result<QuotaDecision> {
    check(state, org_id, Metric::Events, n, Utc::now()).await
}

/// Count `n` flag evaluations (one per flag in the response, not per request)
/// against `org_id`'s current-month flag-call quota. Call sites
/// (`endpoint_flags.rs`/`endpoint_defs.rs`) increment by the number of flags
/// returned and reject with `402` when `!decision.allowed`.
pub async fn check_flags(state: &AppState, org_id: &str, n: i64) -> anyhow::Result<QuotaDecision> {
    check(state, org_id, Metric::Flags, n, Utc::now()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// A fresh `ConnectionManager` against the local dev/test Redis
    /// (`docker-compose.yml`'s `redis:6380`, `REDIS_URL` in `.env.example`).
    /// Mirrors the connection the running service would hold, but scoped to
    /// each test's own randomly-suffixed key so tests never collide.
    async fn test_redis() -> redis::aio::ConnectionManager {
        let url =
            std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6380".to_string());
        let client = redis::Client::open(url).expect("valid REDIS_URL");
        redis::aio::ConnectionManager::new(client)
            .await
            .expect("connect to test Redis (is `make infra:up` running?)")
    }

    fn test_key(name: &str) -> String {
        format!("test:quota:{name}:{}", Uuid::now_v7())
    }

    #[tokio::test]
    async fn lua_increments_correctly() {
        let mut redis = test_redis().await;
        let key = test_key("increments");

        let d1 = increment_and_check(&mut redis, &key, 3, 100, true, false)
            .await
            .unwrap();
        assert_eq!(d1.current, 3);
        assert!(!d1.over);

        let d2 = increment_and_check(&mut redis, &key, 4, 100, true, false)
            .await
            .unwrap();
        assert_eq!(d2.current, 7);
        assert!(!d2.over);
    }

    #[tokio::test]
    async fn lua_sets_pexpire_only_on_first_write() {
        let mut redis = test_redis().await;
        let key = test_key("pexpire-once");

        // First write: key didn't exist -> PEXPIRE is set.
        increment_and_check(&mut redis, &key, 1, 100, true, false)
            .await
            .unwrap();
        let ttl_after_first: i64 = redis::cmd("PTTL")
            .arg(&key)
            .query_async(&mut redis)
            .await
            .unwrap();
        assert!(ttl_after_first > 0, "expected a TTL after the first write");

        // Strip the TTL to make a reset on the *next* write observable.
        let _: () = redis::cmd("PERSIST")
            .arg(&key)
            .query_async(&mut redis)
            .await
            .unwrap();
        let ttl_after_persist: i64 = redis::cmd("PTTL")
            .arg(&key)
            .query_async(&mut redis)
            .await
            .unwrap();
        assert_eq!(ttl_after_persist, -1, "PERSIST should have cleared the TTL");

        // Second write: key already existed -> script must NOT re-PEXPIRE.
        increment_and_check(&mut redis, &key, 1, 100, true, false)
            .await
            .unwrap();
        let ttl_after_second: i64 = redis::cmd("PTTL")
            .arg(&key)
            .query_async(&mut redis)
            .await
            .unwrap();
        assert_eq!(
            ttl_after_second, -1,
            "PEXPIRE must only be set on the first write in a window"
        );
    }

    #[tokio::test]
    async fn lua_over_limit_boundary() {
        let mut redis = test_redis().await;
        let key = test_key("boundary");

        // Exactly at the limit: still under.
        let at_limit = increment_and_check(&mut redis, &key, 5, 5, true, false)
            .await
            .unwrap();
        assert_eq!(at_limit.current, 5);
        assert_eq!(at_limit.limit, 5);
        assert!(!at_limit.over, "current == limit must not be over");

        // One more would push strictly over: flagged over, and — since
        // enforce is on and the policy is block (not allow) — rejected, so
        // NOT counted; the counter must stay at the last accepted value.
        let over_limit = increment_and_check(&mut redis, &key, 1, 5, true, false)
            .await
            .unwrap();
        assert_eq!(
            over_limit.current, 5,
            "a rejected batch must leave the counter unchanged"
        );
        assert!(over_limit.over, "would_be > limit must be flagged over");
    }

    /// The core regression test for this fix: a batch that would be
    /// rejected (over limit, enforce on, policy block) must NOT increment
    /// the Redis counter at all — not by the full batch size, not
    /// partially. Retrying the same rejected batch repeatedly must never
    /// move the counter.
    #[tokio::test]
    async fn lua_rejected_batch_does_not_increment_counter() {
        let mut redis = test_redis().await;
        let key = test_key("rejected-no-increment");

        // Get right up to the limit.
        let baseline = increment_and_check(&mut redis, &key, 10, 10, true, false)
            .await
            .unwrap();
        assert_eq!(baseline.current, 10);
        assert!(!baseline.over);

        // A batch that would cross the limit is rejected — counter must not move.
        for _ in 0..4 {
            let rejected = increment_and_check(&mut redis, &key, 5, 10, true, false)
                .await
                .unwrap();
            assert!(
                rejected.over,
                "batch that crosses the limit must be flagged over"
            );
            assert_eq!(
                rejected.current, 10,
                "rejected batch (even retried) must never inflate the counter"
            );
        }

        // Redis itself agrees — no drift beyond the accepted total.
        let stored: i64 = redis::cmd("GET")
            .arg(&key)
            .query_async(&mut redis)
            .await
            .unwrap();
        assert_eq!(
            stored, 10,
            "underlying Redis counter must match true accepted count"
        );
    }

    /// When `QUOTA_ENFORCE` is off, an over-limit batch is still allowed to
    /// proceed (per module docs) — so it must still be counted, unlike the
    /// enforce-on/block-policy rejection case above.
    #[tokio::test]
    async fn lua_over_limit_still_counts_when_enforce_off() {
        let mut redis = test_redis().await;
        let key = test_key("enforce-off-still-counts");

        let d1 = increment_and_check(&mut redis, &key, 10, 5, false, false)
            .await
            .unwrap();
        assert!(d1.over);
        assert_eq!(
            d1.current, 10,
            "enforce off must still count over-limit traffic that proceeds"
        );
    }

    /// An `allow`-overage org's traffic proceeds past its limit (per module
    /// docs) — so it must still be counted, unlike the
    /// enforce-on/block-policy rejection case above.
    #[tokio::test]
    async fn lua_over_limit_still_counts_when_policy_allows_overage() {
        let mut redis = test_redis().await;
        let key = test_key("policy-allow-still-counts");

        let d1 = increment_and_check(&mut redis, &key, 10, 5, true, true)
            .await
            .unwrap();
        assert!(d1.over);
        assert_eq!(
            d1.current, 10,
            "allow-overage policy must still count over-limit traffic that proceeds"
        );
    }

    /// Helper mirroring the shape [`increment_and_check`] would have returned
    /// for an org that is over its limit (`current > limit`), so the
    /// policy-gate tests don't need a real Redis round-trip.
    fn raw_over_limit() -> RawCount {
        RawCount {
            over: true,
            current: 42,
            limit: 10,
        }
    }

    fn raw_under_limit() -> RawCount {
        RawCount {
            over: false,
            current: 3,
            limit: 10,
        }
    }

    #[test]
    fn over_limit_allow_policy_lets_request_through_and_flags_over() {
        let decision = apply_policy_gate(raw_over_limit(), true, OveragePolicy::Allow);
        assert!(
            decision.allowed,
            "allow policy must accept over-limit traffic when enforce is on"
        );
        assert!(decision.over, "over must stay true regardless of policy");
        assert_eq!(decision.current, 42, "counting is unconditional");
        assert_eq!(decision.policy, OveragePolicy::Allow);
    }

    #[test]
    fn over_limit_block_policy_with_enforce_on_rejects() {
        let decision = apply_policy_gate(raw_over_limit(), true, OveragePolicy::Block);
        assert!(
            !decision.allowed,
            "block policy + enforce on must reject over-limit traffic"
        );
        assert!(decision.over);
        assert_eq!(decision.current, 42, "counting still happened");
    }

    #[test]
    fn enforce_off_never_rejects_regardless_of_policy_but_keeps_counting() {
        let over_limit = raw_over_limit();

        let blocked_but_enforce_off = apply_policy_gate(over_limit, false, OveragePolicy::Block);
        assert!(
            blocked_but_enforce_off.allowed,
            "QUOTA_ENFORCE=off must never reject, even under block policy"
        );
        assert_eq!(blocked_but_enforce_off.current, 42);

        let allow_and_enforce_off = apply_policy_gate(over_limit, false, OveragePolicy::Allow);
        assert!(allow_and_enforce_off.allowed);
        assert_eq!(allow_and_enforce_off.current, 42);
    }

    #[test]
    fn policy_gate_is_a_noop_on_allowed_when_already_under_limit() {
        let under_limit = raw_under_limit();

        for policy in [OveragePolicy::Block, OveragePolicy::Allow] {
            let with_enforce_on = apply_policy_gate(under_limit, true, policy);
            assert!(with_enforce_on.allowed, "under limit is always allowed");
            assert!(!with_enforce_on.over);

            let with_enforce_off = apply_policy_gate(under_limit, false, policy);
            assert!(with_enforce_off.allowed);
            assert!(!with_enforce_off.over);
        }
    }

    #[test]
    fn overage_policy_from_str_lenient_fails_closed() {
        assert_eq!(
            OveragePolicy::from_str_lenient("allow"),
            OveragePolicy::Allow
        );
        assert_eq!(
            OveragePolicy::from_str_lenient("block"),
            OveragePolicy::Block
        );
        assert_eq!(
            OveragePolicy::from_str_lenient("garbage"),
            OveragePolicy::Block,
            "unknown policy strings must fail closed to Block"
        );
    }
}
