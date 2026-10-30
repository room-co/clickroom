//! Taxonomy auto-discovery on ingest, Redis-guarded.
//!
//! As each batch of events is written to ClickHouse, this module catalogs the
//! distinct `(event, property, scope)` tuples it observes into the Postgres
//! control-plane tables (`EventDefinition`, `PropertyDefinition`,
//! `EventProperty`) so the product UI gets autocomplete + a data-management
//! surface for free.
//!
//! ## Redis guard → steady-state zero Postgres writes
//!
//! Every catalogable fact is a member of a per-project Redis set
//! `tax:seen:<project_id>`:
//! - `e:<event>`                — an event definition
//! - `pe:<key>`                 — an event-scope property definition
//! - `pp:<key>`                 — a person-scope property definition (`$set`)
//! - `ep:<event>:<key>`         — an event↔property link
//!
//! A batch first `SISMEMBER`-checks all its candidate members; only *novel*
//! members trigger a Postgres write, and the members are `SADD`-ed only after
//! that write succeeds. Once a project's catalog is warm the set already
//! contains every member, so a steady-state batch does zero Postgres writes.
//!
//! ## Best-effort — never gates the ack
//!
//! Discovery is strictly best-effort: any Redis/Postgres error is logged and
//! swallowed. The ClickHouse insert + message ack remain the authoritative
//! path; a taxonomy failure must never crash the consumer or block delivery.
//! Novel upserts use `ON CONFLICT ... DO NOTHING` so discovery never overwrites
//! an existing row (type changes happen only via the tRPC update path).

use std::collections::HashMap;

use redis::aio::ConnectionManager;
use serde_json::Value;
use sqlx::{PgPool, QueryBuilder};

use crate::infer::{infer_type, PropertyType};
use crate::models::RawEvent;

/// Postgres pool + Redis guard handle for taxonomy discovery. Cheaply clonable.
#[derive(Clone)]
pub struct Taxonomy {
    pg: PgPool,
    redis: ConnectionManager,
}

/// A single novel fact to be upserted into the control-plane catalog. The
/// enclosing map key is the Redis guard member string.
enum Candidate {
    /// An `EventDefinition` row.
    EventDef { name: String, is_system: bool },
    /// A `PropertyDefinition` row (`scope` is `"event"` or `"person"`).
    PropDef {
        name: String,
        scope: &'static str,
        ptype: PropertyType,
    },
    /// An `EventProperty` link row.
    EventProp { event: String, property: String },
}

impl Taxonomy {
    /// Build a discovery handle from the shared Postgres pool + Redis manager.
    pub fn new(pg: PgPool, redis: ConnectionManager) -> Self {
        Self { pg, redis }
    }

    /// Discover + catalog every novel taxonomy fact in `events`. Best-effort:
    /// logs and swallows all errors, never returns one, and must be safe to call
    /// after the batch has already been inserted + acked.
    pub async fn discover(&self, events: &[RawEvent]) {
        if events.is_empty() {
            return;
        }

        // Group candidate facts by project. Within a project a HashMap keyed by
        // the Redis member string dedups repeated facts across the batch.
        let mut by_project: HashMap<&str, HashMap<String, Candidate>> = HashMap::new();

        for ev in events {
            let bucket = by_project.entry(ev.project_id.as_str()).or_default();
            collect_candidates(ev, bucket);
        }

        for (project_id, candidates) in by_project {
            if let Err(e) = self.flush_project(project_id, candidates).await {
                // Best-effort: discovery must never fail the ack path.
                tracing::warn!(project_id, error = %e, "taxonomy discovery failed (ignored)");
            }
        }
    }

    /// Guard-check a project's candidates against Redis, upsert the novel ones
    /// into Postgres, then mark them seen. Any error propagates to the caller,
    /// which logs + swallows it.
    async fn flush_project(
        &self,
        project_id: &str,
        candidates: HashMap<String, Candidate>,
    ) -> anyhow::Result<()> {
        if candidates.is_empty() {
            return Ok(());
        }

        let set_key = format!("tax:seen:{project_id}");
        let members: Vec<String> = candidates.keys().cloned().collect();

        // 1. Guard: which members has this project already cataloged?
        let mut conn = self.redis.clone();
        let mut pipe = redis::pipe();
        for m in &members {
            pipe.cmd("SISMEMBER").arg(&set_key).arg(m);
        }
        let seen: Vec<bool> = pipe.query_async(&mut conn).await?;

        // 2. Partition the novel candidates by target table.
        let mut event_defs: Vec<(&str, bool)> = Vec::new();
        let mut prop_defs: Vec<(&str, &'static str, PropertyType)> = Vec::new();
        let mut event_props: Vec<(&str, &str)> = Vec::new();
        let mut novel_members: Vec<&str> = Vec::new();

        for (member, already) in members.iter().zip(seen) {
            if already {
                continue;
            }
            novel_members.push(member);
            match &candidates[member] {
                Candidate::EventDef { name, is_system } => event_defs.push((name, *is_system)),
                Candidate::PropDef { name, scope, ptype } => prop_defs.push((name, scope, *ptype)),
                Candidate::EventProp { event, property } => event_props.push((event, property)),
            }
        }

        if novel_members.is_empty() {
            // Steady state: warm catalog, zero Postgres writes.
            return Ok(());
        }

        // 3. Batched upserts (ON CONFLICT DO NOTHING — never overwrite).
        insert_event_defs(&self.pg, project_id, &event_defs).await?;
        insert_prop_defs(&self.pg, project_id, &prop_defs).await?;
        insert_event_props(&self.pg, project_id, &event_props).await?;

        // 4. Mark seen only after a successful Postgres write, so a failed
        //    upsert is retried on the next batch rather than lost forever.
        let mut sadd = redis::cmd("SADD");
        sadd.arg(&set_key);
        for m in &novel_members {
            sadd.arg(*m);
        }
        let _: () = sadd.query_async(&mut conn).await?;

        tracing::debug!(
            project_id,
            event_defs = event_defs.len(),
            prop_defs = prop_defs.len(),
            event_props = event_props.len(),
            "taxonomy discovery upserted novel definitions"
        );
        Ok(())
    }
}

/// Extract every catalogable fact from one event into `bucket`, keyed by its
/// Redis guard member string.
fn collect_candidates(ev: &RawEvent, bucket: &mut HashMap<String, Candidate>) {
    let event = ev.event.as_str();

    // Event definition. `$`-prefixed events are system events.
    bucket
        .entry(format!("e:{event}"))
        .or_insert_with(|| Candidate::EventDef {
            name: event.to_string(),
            is_system: event.starts_with('$'),
        });

    let props = ev.properties_object();
    let obj = match props.as_object() {
        Some(o) => o,
        None => return,
    };

    // Event-scope property definitions + event↔property links, for every
    // top-level property key.
    for (key, value) in obj {
        bucket
            .entry(format!("pe:{key}"))
            .or_insert_with(|| Candidate::PropDef {
                name: key.clone(),
                scope: "event",
                ptype: infer_type(value),
            });

        bucket
            .entry(format!("ep:{event}:{key}"))
            .or_insert_with(|| Candidate::EventProp {
                event: event.to_string(),
                property: key.clone(),
            });
    }

    // Person-scope property definitions from `$set` (identify enrichment).
    if let Some(set) = obj.get("$set").and_then(Value::as_object) {
        for (key, value) in set {
            bucket
                .entry(format!("pp:{key}"))
                .or_insert_with(|| Candidate::PropDef {
                    name: key.clone(),
                    scope: "person",
                    ptype: infer_type(value),
                });
        }
    }
}

/// Generate a fresh unique row id. Format need not match the TS cuid; a ULID is
/// unique, sortable, and compact.
fn new_id() -> String {
    ulid::Ulid::new().to_string()
}

/// Multi-row upsert into `EventDefinition` (ON CONFLICT (projectId,name) DO
/// NOTHING). `updatedAt` is set explicitly (Prisma normally sets it).
async fn insert_event_defs(
    pg: &PgPool,
    project_id: &str,
    rows: &[(&str, bool)],
) -> anyhow::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut qb = QueryBuilder::new(
        r#"INSERT INTO "EventDefinition" ("id","projectId","name","isSystem","updatedAt") "#,
    );
    qb.push_values(rows, |mut b, (name, is_system)| {
        b.push_bind(new_id())
            .push_bind(project_id)
            .push_bind(*name)
            .push_bind(*is_system)
            .push("now()");
    });
    qb.push(r#" ON CONFLICT ("projectId","name") DO NOTHING"#);
    qb.build().execute(pg).await?;
    Ok(())
}

/// Multi-row upsert into `PropertyDefinition` (ON CONFLICT (projectId,name,scope)
/// DO NOTHING). `scope`/`propertyType` are bound as text and cast to their
/// Postgres enum types.
async fn insert_prop_defs(
    pg: &PgPool,
    project_id: &str,
    rows: &[(&str, &'static str, PropertyType)],
) -> anyhow::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut qb = QueryBuilder::new(
        r#"INSERT INTO "PropertyDefinition" ("id","projectId","name","scope","propertyType","isNumerical","updatedAt") "#,
    );
    qb.push_values(rows, |mut b, (name, scope, ptype)| {
        b.push_bind(new_id()).push_bind(project_id).push_bind(*name);
        b.push_bind(*scope).push_unseparated(r#"::"PropertyScope""#);
        b.push_bind(ptype.as_db())
            .push_unseparated(r#"::"PropertyType""#);
        b.push_bind(ptype.is_numerical()).push("now()");
    });
    qb.push(r#" ON CONFLICT ("projectId","name","scope") DO NOTHING"#);
    qb.build().execute(pg).await?;
    Ok(())
}

/// Multi-row upsert into `EventProperty` (ON CONFLICT
/// (projectId,eventName,propertyName) DO NOTHING).
async fn insert_event_props(
    pg: &PgPool,
    project_id: &str,
    rows: &[(&str, &str)],
) -> anyhow::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut qb = QueryBuilder::new(
        r#"INSERT INTO "EventProperty" ("id","projectId","eventName","propertyName") "#,
    );
    qb.push_values(rows, |mut b, (event, property)| {
        b.push_bind(new_id())
            .push_bind(project_id)
            .push_bind(*event)
            .push_bind(*property);
    });
    qb.push(r#" ON CONFLICT ("projectId","eventName","propertyName") DO NOTHING"#);
    qb.build().execute(pg).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(event: &str, properties: Value) -> RawEvent {
        RawEvent {
            uuid: "u".into(),
            project_id: "proj_1".into(),
            event: event.into(),
            distinct_id: "d".into(),
            timestamp: "2026-07-04T12:00:00Z".into(),
            properties,
            elements_chain: String::new(),
            created_at: "2026-07-04T12:00:00Z".into(),
        }
    }

    #[test]
    fn collects_event_def_and_event_scope_props() {
        let mut bucket = HashMap::new();
        collect_candidates(
            &ev("signup", json!({ "plan": "pro", "count": 3 })),
            &mut bucket,
        );

        assert!(matches!(
            bucket.get("e:signup"),
            Some(Candidate::EventDef {
                is_system: false,
                ..
            })
        ));
        assert!(matches!(
            bucket.get("pe:plan"),
            Some(Candidate::PropDef {
                scope: "event",
                ptype: PropertyType::String,
                ..
            })
        ));
        assert!(matches!(
            bucket.get("pe:count"),
            Some(Candidate::PropDef {
                ptype: PropertyType::Numeric,
                ..
            })
        ));
        assert!(matches!(
            bucket.get("ep:signup:plan"),
            Some(Candidate::EventProp { .. })
        ));
    }

    #[test]
    fn dollar_prefixed_event_is_system() {
        let mut bucket = HashMap::new();
        collect_candidates(&ev("$pageview", json!({})), &mut bucket);
        assert!(matches!(
            bucket.get("e:$pageview"),
            Some(Candidate::EventDef {
                is_system: true,
                ..
            })
        ));
    }

    #[test]
    fn identify_set_yields_person_scope_props() {
        let mut bucket = HashMap::new();
        collect_candidates(
            &ev(
                "$identify",
                json!({ "$set": { "email": "a@b.com", "age": 30 } }),
            ),
            &mut bucket,
        );
        assert!(matches!(
            bucket.get("pp:email"),
            Some(Candidate::PropDef {
                scope: "person",
                ptype: PropertyType::String,
                ..
            })
        ));
        assert!(matches!(
            bucket.get("pp:age"),
            Some(Candidate::PropDef {
                scope: "person",
                ptype: PropertyType::Numeric,
                ..
            })
        ));
    }

    #[test]
    fn non_object_properties_still_yield_event_def() {
        let mut bucket = HashMap::new();
        collect_candidates(&ev("click", json!(null)), &mut bucket);
        assert_eq!(bucket.len(), 1);
        assert!(bucket.contains_key("e:click"));
    }

    #[test]
    fn new_id_is_unique() {
        assert_ne!(new_id(), new_id());
    }
}
