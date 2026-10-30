//! Flag evaluation (canonical ). First matching group wins; a matched
//! group that is rolled off STOPS (no fallthrough to later groups).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::hash::hash_flag;
use super::property::{prop_match, Filters, Group};

/// A single evaluable flag (as stored in the Redis blob / Postgres row).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlagDef {
    /// Stable flag key (used for hashing and as the response map key).
    pub key: String,
    /// Whether the flag is enabled at all.
    pub active: bool,
    /// Whether an exposure (`$feature_flag_called`) is emitted on evaluation.
    /// Gates only the exposure write — evaluation and quota are unaffected.
    #[serde(default)]
    pub track: bool,
    /// Targeting rules.
    #[serde(default)]
    pub filters: Filters,
    /// Monotonic version (summed into the blob-level version).
    #[serde(default)]
    pub version: i64,
}

/// Result of evaluating one flag for one user.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EvalResult {
    /// Whether the flag is on for this user.
    pub enabled: bool,
    /// Selected variant key (multivariate/pinned), else `null`.
    pub variant: Option<String>,
    /// Variant payload from `filters.payloads`, else `null`.
    pub payload: Option<Value>,
    /// Whether exposures are tracked for this flag. Carried through
    /// to the `/flags` response so the browser SDK's `maybeEmitFlagCall` can gate
    /// on it — a `track:false` operational gate read must emit no exposure. Set
    /// from the flag def by `evaluate`; the internal builders leave it `false`.
    #[serde(default)]
    pub track: bool,
}

impl EvalResult {
    /// The "off" result: disabled, no variant, no payload. `track` is stamped by
    /// `evaluate` from the flag def, so it starts `false` here.
    fn off() -> Self {
        EvalResult {
            enabled: false,
            variant: None,
            payload: None,
            track: false,
        }
    }
}

/// All property predicates in a group match (empty properties -> everyone).
fn group_matches(group: &Group, person_props: &Map<String, Value>) -> bool {
    group
        .properties
        .iter()
        .all(|p| prop_match(&p.operator, person_props.get(&p.key), &p.value))
}

/// Pick a multivariate variant by cumulative rollout (strict `<`); falls back to
/// the last variant. Returns `None` only when there are no variants.
fn pick_variant(flag: &FlagDef, distinct_id: &str) -> Option<String> {
    let mv = flag.filters.multivariate.as_ref()?;
    let f = hash_flag(&flag.key, distinct_id, "variant");
    let mut cumulative = 0.0_f64;
    for v in &mv.variants {
        cumulative += v.rollout_percentage / 100.0;
        if f < cumulative {
            return Some(v.key.clone());
        }
    }
    mv.variants.last().map(|v| v.key.clone())
}

/// Whether a `bucket` in `[0, 1]` falls inside a rollout of `rollout_percentage`
/// (`0..=100`). Must stay byte-for-byte semantically identical to the JS SDK
/// evaluator (parity).
///
/// Both guards exist because the plain `bucket < pct / 100.0` comparison is wrong
/// at the two extremes:
/// - At 0% the slice is empty, but a user hashing to exactly `0.0` would satisfy
///   `bucket <= 0.0` (and any `<=`-style check), letting somebody in when the
///   rollout must serve nobody.
/// - `hash_flag` divides by `0xfffffffffffffff` with a numerator that can *equal*
///   the denominator, so the bucket range is `[0, 1]` INCLUSIVE. A strict `<`
///   would therefore exclude a max-hash user (`bucket == 1.0`) from a 100%
///   rollout, which must serve everyone.
///
/// In between, the comparison is strict so a bucket exactly on a boundary belongs
/// to the next slice (matching `pick_variant`'s cumulative `<`).
pub fn in_rollout(bucket: f64, rollout_percentage: f64) -> bool {
    if rollout_percentage <= 0.0 {
        return false; // 0% serves nobody
    }
    if rollout_percentage >= 100.0 {
        return true; // 100% serves everyone (bucket can be exactly 1.0)
    }
    bucket < rollout_percentage / 100.0 // strict: boundary belongs to the next slice
}

/// Evaluate `flag` for `distinct_id`/`person_props` per , stamping the
/// flag's `track` flag onto the result so it reaches the SDK.
pub fn evaluate(
    flag: &FlagDef,
    distinct_id: &str,
    person_props: &Map<String, Value>,
) -> EvalResult {
    EvalResult {
        track: flag.track,
        ..evaluate_inner(flag, distinct_id, person_props)
    }
}

/// Core evaluation. Returns a result with `track` left `false`; `evaluate`
/// stamps the real value from the flag def.
fn evaluate_inner(
    flag: &FlagDef,
    distinct_id: &str,
    person_props: &Map<String, Value>,
) -> EvalResult {
    if !flag.active {
        return EvalResult::off();
    }

    for group in &flag.filters.groups {
        if !group_matches(group, person_props) {
            continue; // try next group
        }
        // Matched group: decide by rollout bucket.
        if in_rollout(
            hash_flag(&flag.key, distinct_id, ""),
            group.rollout_percentage,
        ) {
            // Group pinned to serve OFF (boolean default groups): STOP (no fallthrough).
            if group.serve == Some(false) {
                return EvalResult::off();
            }
            let variant = if flag.filters.multivariate.is_some() {
                pick_variant(flag, distinct_id)
            } else {
                group.variant.clone()
            };
            let payload = variant.as_ref().and_then(|v| {
                flag.filters
                    .payloads
                    .as_ref()
                    .and_then(|p| p.get(v).cloned())
            });
            return EvalResult {
                enabled: true,
                variant,
                payload,
                track: false,
            };
        }
        // In-group but rolled off: STOP (no fallthrough).
        return EvalResult::off();
    }

    EvalResult::off()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Canonical parity fixture — ground truth shared with the JS SDK (AC-5/6).
    /// Path is relative to this source file: repo root is four dirs up.
    const FIXTURE: &str =
        include_str!("../../../../packages/sdk-js/src/__fixtures__/flag-vectors.json");

    #[derive(Deserialize)]
    struct Fixture {
        vectors: Vec<Vector>,
    }

    #[derive(Deserialize)]
    struct Vector {
        flag: FlagDef,
        distinct_id: String,
        #[serde(default)]
        person_properties: Map<String, Value>,
        expected: EvalResult,
    }

    #[test]
    fn parity_with_sdk_fixture() {
        let fx: Fixture = serde_json::from_str(FIXTURE).expect("fixture parses");
        assert!(!fx.vectors.is_empty(), "fixture has vectors");
        let mut count = 0usize;
        for (i, v) in fx.vectors.iter().enumerate() {
            let got = evaluate(&v.flag, &v.distinct_id, &v.person_properties);
            assert_eq!(
                got, v.expected,
                "vector[{i}] key={} distinct_id={} mismatch",
                v.flag.key, v.distinct_id
            );
            count += 1;
        }
        eprintln!("parity: {count} vectors matched");
    }

    #[test]
    fn inactive_flag_is_off() {
        let flag: FlagDef = serde_json::from_value(json!({
            "key": "x", "active": false, "filters": {"groups": []}
        }))
        .unwrap();
        assert_eq!(evaluate(&flag, "u", &Map::new()), EvalResult::off());
    }

    #[test]
    fn flagdef_roundtrips_track() {
        // Present in the blob/SELECT -> preserved through de/serialize.
        let def: FlagDef = serde_json::from_value(json!({
            "key": "exp", "active": true, "track": true, "filters": { "groups": [] }
        }))
        .unwrap();
        assert!(def.track, "track deserializes from the blob");
        let back = serde_json::to_value(&def).unwrap();
        assert_eq!(
            back["track"],
            json!(true),
            "track serializes for the SDK payload"
        );

        // Absent (legacy rows / earlier blob) -> defaults false.
        let legacy: FlagDef =
            serde_json::from_value(json!({ "key": "gate", "active": true })).unwrap();
        assert!(!legacy.track, "track defaults false when absent");
    }

    #[test]
    fn evaluate_stamps_track_into_response() {
        // The SDK reads `track` off the eval RESULT (the `/flags` response value),
        // not the def — the browser exposure gate depends on it being present.
        let tracked: FlagDef = serde_json::from_value(json!({
            "key": "exp", "active": true, "track": true, "filters": { "groups": [] }
        }))
        .unwrap();
        let r = evaluate(&tracked, "u", &Map::new());
        assert!(r.track, "tracked flag -> result carries track:true");
        assert_eq!(
            serde_json::to_value(&r).unwrap()["track"],
            json!(true),
            "track is serialized into the /flags response the SDK receives"
        );

        // Operational gate: evaluated + returned, but track:false so the SDK
        // suppresses the exposure.
        let gate: FlagDef = serde_json::from_value(json!({
            "key": "gate", "active": true, "track": false, "filters": { "groups": [] }
        }))
        .unwrap();
        assert!(
            !evaluate(&gate, "u", &Map::new()).track,
            "untracked gate -> result carries track:false"
        );
    }

    #[test]
    fn zero_rollout_serves_nobody() {
        assert!(!in_rollout(0.0, 0.0));
        assert!(!in_rollout(0.5, 0.0));
    }

    #[test]
    fn full_rollout_serves_everyone() {
        assert!(in_rollout(1.0, 100.0));
        assert!(in_rollout(0.0, 100.0));
    }

    #[test]
    fn rollout_boundary_belongs_to_next_slice() {
        assert!(!in_rollout(0.5, 50.0));
        assert!(in_rollout(0.4999, 50.0));
        assert!(!in_rollout(0.3, 30.0));
    }
}
