//! Identity merge on `$identify` — ClickHouse-only side
//! write against `person_distinct_ids`.
//!
//! Mirrors `taxonomy.rs`'s shape (a small handle constructed once in `main`,
//! invoked from the consumer loop right after the batch insert succeeds) but
//! the store here is ClickHouse itself, not Postgres/Redis: `identify()`
//! (sdk-js) attaches the pre-identify id as
//! `properties.$anon_distinct_id` on the `$identify` event, and this module
//! resolves/merges it against the mapping table using the 4-branch policy
//! described in the design notes:
//!
//! 1. Neither id mapped yet → mint a fresh `person_id`, insert both rows.
//! 2. One id unmapped, the other already mapped to `person_id` P → the
//!    unmapped id joins P.
//! 3. Both already mapped to the *same* `person_id` → no-op.
//! 4. Both mapped to *different* `person_id`s → merge: the newer person's
//!    distinct_ids are re-inserted under the older (canonical) person.
//!    `ReplacingMergeTree` supersedes the stale rows on the next background
//!    merge/`FINAL` since the re-insert carries a newer `created_at` for the
//!    same `(project_id, distinct_id)` key. The collision is logged
//!    (structured `tracing::warn!`), never silently dropped.
//!
//! ## Best-effort — never gates the ack
//!
//! Like taxonomy discovery, this is strictly best-effort: any ClickHouse
//! error is logged and swallowed. The batch insert + ack are the
//! authoritative path; an identity-merge failure must never crash the
//! consumer or block delivery — a failed merge is retried next time either id
//! appears in a batch (idempotent: re-running the same branch is a no-op or
//! re-adopts the same mapping).

use serde_json::Value;
use uuid::Uuid;

use crate::clickhouse::ClickHouseClient;
use crate::models::RawEvent;

/// ClickHouse handle for identity resolution. Cheaply clonable (wraps the
/// already-cheap `ClickHouseClient`).
#[derive(Clone)]
pub struct Identity {
    ch: ClickHouseClient,
}

/// Which merge-policy branch was applied for one `(anon_id, identified_id)`
/// pair. Exposed for logging + unit testing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeBranch {
    /// Neither id was mapped: minted a fresh `person_id` for both.
    NewPerson { person_id: String },
    /// One id was unmapped, the other already resolved to `person_id`: the
    /// unmapped id joined the existing person.
    Adopted { person_id: String },
    /// Both ids already resolve to the same person: nothing to write.
    NoOp { person_id: String },
    /// Both ids resolved to different persons: merged the newer person's
    /// distinct_ids under the older (canonical) person.
    Merged {
        canonical: String,
        merged_from: String,
    },
}

impl Identity {
    /// Build an identity-merge handle over the shared ClickHouse client.
    pub fn new(ch: ClickHouseClient) -> Self {
        Self { ch }
    }

    /// Best-effort: apply the merge policy for every `$identify` event in the
    /// batch that carries a `properties.$anon_distinct_id` distinct from the
    /// event's own `distinct_id`. Must be called after the batch insert has
    /// already succeeded (same call site as `Taxonomy::discover`).
    pub async fn resolve(&self, events: &[RawEvent]) {
        for ev in events {
            if ev.event != "$identify" {
                continue;
            }

            let props = ev.properties_object();
            let anon_id = match props.get("$anon_distinct_id").and_then(Value::as_str) {
                Some(s) if !s.is_empty() => s,
                _ => continue,
            };
            let identified_id = ev.distinct_id.as_str();
            if anon_id == identified_id {
                // identify() only attaches $anon_distinct_id when it actually
                // changed, but stay defensive against replays/hand-rolled
                // events that violate that contract.
                continue;
            }

            match self.merge(&ev.project_id, anon_id, identified_id).await {
                Ok(MergeBranch::Merged {
                    canonical,
                    merged_from,
                }) => {
                    tracing::warn!(
                        project_id = %ev.project_id,
                        anon_id,
                        identified_id,
                        canonical,
                        merged_from,
                        "identity collision: merged two persons into one canonical person"
                    );
                }
                Ok(branch) => {
                    tracing::debug!(
                        project_id = %ev.project_id,
                        anon_id,
                        identified_id,
                        ?branch,
                        "identity resolved"
                    );
                }
                Err(e) => {
                    // Best-effort: never gate the ack. A failed merge simply
                    // retries next time either id shows up in a batch.
                    tracing::warn!(
                        project_id = %ev.project_id,
                        anon_id,
                        identified_id,
                        error = %e,
                        "identity merge failed (ignored)"
                    );
                }
            }
        }
    }

    /// Apply the 4-branch merge policy for one `(anon_id,
    /// identified_id)` pair within `project_id`. Returns the branch taken.
    async fn merge(
        &self,
        project_id: &str,
        anon_id: &str,
        identified_id: &str,
    ) -> anyhow::Result<MergeBranch> {
        let mapping = self
            .ch
            .person_current_mapping(project_id, &[anon_id, identified_id])
            .await?;

        let anon_person = mapping.get(anon_id).cloned();
        let identified_person = mapping.get(identified_id).cloned();

        match (anon_person, identified_person) {
            // Branch 1: neither id mapped yet.
            (None, None) => {
                let person_id = Uuid::now_v7().to_string();
                let now = now_ch();
                self.ch
                    .insert_person_distinct_ids(
                        project_id,
                        &[
                            (anon_id, person_id.as_str(), now.as_str()),
                            (identified_id, person_id.as_str(), now.as_str()),
                        ],
                    )
                    .await?;
                Ok(MergeBranch::NewPerson { person_id })
            }
            // Branch 2: anon unmapped, identified already resolved.
            (None, Some(person_id)) => {
                let now = now_ch();
                self.ch
                    .insert_person_distinct_ids(
                        project_id,
                        &[(anon_id, person_id.as_str(), now.as_str())],
                    )
                    .await?;
                Ok(MergeBranch::Adopted { person_id })
            }
            // Symmetric case not spelled out verbatim in the design notes (which assumes
            // the anon id starts unmapped) but reachable in practice — e.g. a
            // known distinct_id is `identify()`-d for the first time while the
            // anon session already has history. Same "adopt" shape, mirrored.
            (Some(person_id), None) => {
                let now = now_ch();
                self.ch
                    .insert_person_distinct_ids(
                        project_id,
                        &[(identified_id, person_id.as_str(), now.as_str())],
                    )
                    .await?;
                Ok(MergeBranch::Adopted { person_id })
            }
            // Branch 3: both already mapped to the same person.
            (Some(p1), Some(p2)) if p1 == p2 => Ok(MergeBranch::NoOp { person_id: p1 }),
            // Branch 4: both mapped, but to two different persons — merge,
            // picking the older (by earliest created_at) as canonical.
            (Some(p1), Some(p2)) => {
                let earliest = self
                    .ch
                    .person_earliest_created_at(project_id, &[p1.as_str(), p2.as_str()])
                    .await?;
                let p1_first = earliest.get(&p1).cloned().unwrap_or_default();
                let p2_first = earliest.get(&p2).cloned().unwrap_or_default();

                let (canonical, loser) = if p1_first <= p2_first {
                    (p1, p2)
                } else {
                    (p2, p1)
                };

                let loser_distinct_ids = self
                    .ch
                    .person_distinct_ids_for_person(project_id, &loser)
                    .await?;

                if !loser_distinct_ids.is_empty() {
                    let now = now_ch();
                    let rows: Vec<(&str, &str, &str)> = loser_distinct_ids
                        .iter()
                        .map(|d| (d.as_str(), canonical.as_str(), now.as_str()))
                        .collect();
                    self.ch
                        .insert_person_distinct_ids(project_id, &rows)
                        .await?;
                }

                Ok(MergeBranch::Merged {
                    canonical,
                    merged_from: loser,
                })
            }
        }
    }
}

/// Current UTC time formatted for ClickHouse `DateTime64(3, 'UTC')` input.
fn now_ch() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string()
}

#[cfg(test)]
mod tests {
    //! Live-ClickHouse integration tests against the `person_distinct_ids`
    //! table (verify). Requires the docker-compose ClickHouse
    //! instance (`clickroom-clickhouse`, `CLICKHOUSE_URL` default
    //! `http://localhost:8123`, matching `Config::from_env`/`clickhouse.rs`'s
    //! `test_config()`), migration `004_person_distinct_ids.sql` applied.
    //! Skips (rather than fails) when ClickHouse isn't reachable so `cargo
    //! test` stays green in environments without the docker infra up.
    use super::*;
    use crate::config::Config;
    use uuid::Uuid;

    fn test_config() -> Config {
        Config {
            nats_url: "nats://localhost:4222".to_string(),
            clickhouse_url: std::env::var("CLICKHOUSE_URL")
                .unwrap_or_else(|_| "http://localhost:8123".to_string()),
            clickhouse_user: std::env::var("CLICKHOUSE_USER")
                .unwrap_or_else(|_| "clickroom".to_string()),
            clickhouse_password: std::env::var("CLICKHOUSE_PASSWORD")
                .unwrap_or_else(|_| "clickroom".to_string()),
            clickhouse_database: std::env::var("CLICKHOUSE_DATABASE")
                .unwrap_or_else(|_| "clickroom".to_string()),
            durable_name: "ingest".to_string(),
            stream_name: "EVENTS".to_string(),
            subject_filter: "events.raw.>".to_string(),
            batch_max_size: 1000,
            batch_max_wait_ms: 500,
            max_deliver: 5,
            ack_wait_secs: 30,
            dlq_subject_prefix: "events.dlq".to_string(),
            dlq_stream_max_age_secs: 604_800,
            dlq_stream_name: "EVENTS_DLQ".to_string(),
            database_url: "postgresql://clickroom:clickroom@localhost:5433/clickroom".to_string(),
            redis_url: "redis://localhost:6380".to_string(),
            volume_job_interval_secs: 3600,
            volume_job_enabled: true,
            webhook_job_enabled: true,
            webhook_job_interval_secs: 30,
            webhook_max_attempts: 6,
            webhook_request_timeout_secs: 10,
            webhook_sweep_batch_size: 100,
            webhook_subject: "support.webhook.delivery".to_string(),
            webhook_encryption_key_hex: None,
            webhook_retention_enabled: true,
            webhook_retention_interval_secs: 3600,
            webhook_retention_days: 30,
            webhook_delivery_delete_days: 0,
            webhook_allow_private_targets: false,
            webhook_autodisable_subject: "support.webhook.autodisabled".to_string(),
        }
    }

    /// Fresh, never-reused project id per test so parallel test runs (and
    /// pre-merge stale rows from earlier runs) never interfere with each
    /// other's `argMax`/`min`/`HAVING` reads.
    fn project_id() -> String {
        format!("proj_identity_test_{}", Uuid::now_v7())
    }

    async fn live_client() -> Option<ClickHouseClient> {
        let ch = ClickHouseClient::new(&test_config()).expect("build client");
        if ch.ping().await.is_ok() {
            Some(ch)
        } else {
            eprintln!("skipping identity integration test: ClickHouse not reachable");
            None
        }
    }

    #[tokio::test]
    async fn branch_1_neither_mapped_mints_new_person() {
        let Some(ch) = live_client().await else {
            return;
        };
        let identity = Identity::new(ch.clone());
        let project = project_id();

        let branch = identity
            .merge(&project, "anon-1", "user-1")
            .await
            .expect("merge");

        let person_id = match branch {
            MergeBranch::NewPerson { person_id } => person_id,
            other => panic!("expected NewPerson, got {other:?}"),
        };

        let mapping = ch
            .person_current_mapping(&project, &["anon-1", "user-1"])
            .await
            .expect("lookup");
        assert_eq!(mapping.get("anon-1"), Some(&person_id));
        assert_eq!(mapping.get("user-1"), Some(&person_id));
    }

    #[tokio::test]
    async fn branch_2_anon_unmapped_adopts_identified_person() {
        let Some(ch) = live_client().await else {
            return;
        };
        let identity = Identity::new(ch.clone());
        let project = project_id();

        // Seed: user-1 already mapped to some person.
        let seeded = identity
            .merge(&project, "anon-seed", "user-1")
            .await
            .expect("seed merge");
        let existing_person = match seeded {
            MergeBranch::NewPerson { person_id } => person_id,
            other => panic!("expected NewPerson seed, got {other:?}"),
        };

        // anon-2 is unmapped; user-1 already resolves to `existing_person`.
        let branch = identity
            .merge(&project, "anon-2", "user-1")
            .await
            .expect("merge");
        assert_eq!(
            branch,
            MergeBranch::Adopted {
                person_id: existing_person.clone()
            }
        );

        let mapping = ch
            .person_current_mapping(&project, &["anon-2"])
            .await
            .expect("lookup");
        assert_eq!(mapping.get("anon-2"), Some(&existing_person));
    }

    #[tokio::test]
    async fn branch_3_both_mapped_to_same_person_is_noop() {
        let Some(ch) = live_client().await else {
            return;
        };
        let identity = Identity::new(ch.clone());
        let project = project_id();

        let seeded = identity
            .merge(&project, "anon-3", "user-3")
            .await
            .expect("seed merge");
        let person_id = match seeded {
            MergeBranch::NewPerson { person_id } => person_id,
            other => panic!("expected NewPerson seed, got {other:?}"),
        };

        // Re-running with the same pair: both already resolve to the same
        // person now.
        let branch = identity
            .merge(&project, "anon-3", "user-3")
            .await
            .expect("merge");
        assert_eq!(branch, MergeBranch::NoOp { person_id });
    }

    #[tokio::test]
    async fn branch_4_different_persons_merge_older_canonical() {
        let Some(ch) = live_client().await else {
            return;
        };
        let identity = Identity::new(ch.clone());
        let project = project_id();

        // Person P1 (older): seed first so its created_at is earlier.
        let p1 = match identity
            .merge(&project, "anon-old", "user-old")
            .await
            .expect("seed p1")
        {
            MergeBranch::NewPerson { person_id } => person_id,
            other => panic!("expected NewPerson, got {other:?}"),
        };

        // Ensure a strictly later created_at for P2 (ClickHouse
        // DateTime64(3) has millisecond resolution).
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        // Person P2 (newer), with an extra distinct_id (anon-old2) so we can
        // confirm ALL of P2's distinct_ids move over, not just the pair
        // passed into merge().
        let p2 = match identity
            .merge(&project, "anon-new", "user-new")
            .await
            .expect("seed p2")
        {
            MergeBranch::NewPerson { person_id } => person_id,
            other => panic!("expected NewPerson, got {other:?}"),
        };
        assert_ne!(p1, p2);

        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let adopt = identity
            .merge(&project, "anon-old2", "user-new")
            .await
            .expect("adopt into p2");
        assert_eq!(
            adopt,
            MergeBranch::Adopted {
                person_id: p2.clone()
            }
        );

        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        // Now collide: anon-old (→P1) vs user-new (→P2). P1 is older, so it
        // must be canonical; every one of P2's distinct_ids (user-new,
        // anon-new, anon-old2) should move to P1.
        let branch = identity
            .merge(&project, "anon-old", "user-new")
            .await
            .expect("merge collision");
        assert_eq!(
            branch,
            MergeBranch::Merged {
                canonical: p1.clone(),
                merged_from: p2.clone(),
            }
        );

        let mapping = ch
            .person_current_mapping(
                &project,
                &["anon-old", "user-old", "anon-new", "user-new", "anon-old2"],
            )
            .await
            .expect("lookup");
        for id in ["anon-old", "user-old", "anon-new", "user-new", "anon-old2"] {
            assert_eq!(
                mapping.get(id),
                Some(&p1),
                "{id} should resolve to the canonical (older) person"
            );
        }
    }

    #[tokio::test]
    async fn resolve_skips_non_identify_and_missing_anon_id() {
        let Some(ch) = live_client().await else {
            return;
        };
        let identity = Identity::new(ch.clone());
        let project = project_id();

        fn ev(project_id: &str, event: &str, distinct_id: &str, properties: Value) -> RawEvent {
            RawEvent {
                uuid: Uuid::now_v7().to_string(),
                project_id: project_id.to_string(),
                event: event.to_string(),
                distinct_id: distinct_id.to_string(),
                timestamp: "2026-07-04T12:00:00Z".to_string(),
                properties,
                elements_chain: String::new(),
                created_at: "2026-07-04T12:00:00Z".to_string(),
            }
        }

        let events = vec![
            ev(&project, "$pageview", "anon-x", serde_json::json!({})),
            ev(&project, "$identify", "user-x", serde_json::json!({})),
            ev(
                &project,
                "$identify",
                "user-y",
                serde_json::json!({ "$anon_distinct_id": "user-y" }),
            ),
        ];

        // Must not panic/error and must not write anything: no event above
        // yields a novel, differing anon/identified pair.
        identity.resolve(&events).await;

        let mapping = ch
            .person_current_mapping(&project, &["anon-x", "user-x", "user-y"])
            .await
            .expect("lookup");
        assert!(mapping.is_empty());
    }
}
