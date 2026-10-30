//! Security core of the SQL Explorer: parse a tenant-authored SQL string,
//! reject anything that isn't a read-only `SELECT`/`WITH` over the
//! allowlisted event tables, and rewrite every table reference into a
//! derived subquery scoped to the caller's `project_id`.
//!
//! Nothing here trusts the SQL text for tenant scoping — `project_id` is a
//! function parameter supplied by the HTTP layer (itself server-authorized,
//! see `http.rs`), never parsed out of the query.

use std::collections::HashSet;
use std::ops::ControlFlow;

use sqlparser::ast::{
    Ident, ObjectNamePart, Query, Statement, TableAlias, TableFactor, VisitMut, VisitorMut,
};
use sqlparser::dialect::ClickHouseDialect;
use sqlparser::parser::Parser;

/// The only tables a tenant query may reference (bare name, no schema
/// qualifier). Anything else — including `system.*` or any other database —
/// is rejected.
const ALLOWED_TABLES: [&str; 4] = [
    "events",
    "flag_events",
    "survey_events",
    "person_distinct_ids",
];

/// Typed validation failures, each with a message suitable for an HTTP `400`
/// body.
#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum ValidationError {
    /// `sqlparser` failed to parse the input at all.
    #[error("could not parse SQL: {0}")]
    ParseError(String),
    /// More (or fewer) than exactly one statement was submitted.
    #[error("exactly one SQL statement is allowed per query")]
    MultiStatement,
    /// The single statement isn't a `SELECT`/`WITH` query.
    #[error("only SELECT/WITH queries are allowed")]
    NotAQuery,
    /// A table reference outside the allowlist (or schema-qualified / cross-database).
    #[error("table \"{0}\" is not allowed — only events, flag_events, survey_events, person_distinct_ids may be queried")]
    DisallowedTable(String),
    /// A ClickHouse `SETTINGS` clause was present — this would let a query
    /// override the restricted user's resource caps.
    #[error("SETTINGS clauses are not allowed")]
    SettingsClausePresent,
    /// The server-supplied project id failed its own safety check (defense
    /// in depth — this should never happen with a real, internally
    /// generated id).
    #[error("invalid project id")]
    InvalidProjectId,
}

/// Validate `sql`, then rewrite every allowlisted table reference into a
/// `(SELECT * FROM <table> WHERE project_id = '<project_id>') AS <alias>`
/// derived table, and return the rewritten SQL text ready for execution.
///
/// `project_id` must be the server-authorized project id for the caller —
/// never a value taken from `sql` itself.
pub fn validate_and_rewrite(sql: &str, project_id: &str) -> Result<String, ValidationError> {
    if !is_safe_project_id(project_id) {
        return Err(ValidationError::InvalidProjectId);
    }

    let mut statements = Parser::parse_sql(&ClickHouseDialect {}, sql)
        .map_err(|e| ValidationError::ParseError(e.to_string()))?;

    if statements.len() != 1 {
        return Err(ValidationError::MultiStatement);
    }

    let statement = &mut statements[0];
    if !matches!(statement, Statement::Query(_)) {
        return Err(ValidationError::NotAQuery);
    }

    let mut rewriter = ProjectScopeRewriter::new(project_id);
    let _ = statement.visit(&mut rewriter);
    if let Some(err) = rewriter.error {
        return Err(err);
    }

    Ok(statement.to_string())
}

/// Internal id shape is always an internally generated cuid/UUID; restrict to
/// that character set as defense in depth before splicing it into SQL text.
fn is_safe_project_id(project_id: &str) -> bool {
    !project_id.is_empty()
        && project_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Walks the statement's AST (via `sqlparser`'s generic visitor), rejecting
/// disallowed tables / `SETTINGS` clauses and rewriting every allowlisted
/// table reference in place. CTE names are tracked per-scope so a query like
/// `WITH x AS (SELECT * FROM events) SELECT * FROM x` doesn't try to rewrite
/// (or reject) `x` — it isn't a real table.
struct ProjectScopeRewriter {
    project_id: String,
    allowed: HashSet<&'static str>,
    /// Stack of CTE-name sets, one frame per nested `WITH` scope currently
    /// being visited.
    cte_scopes: Vec<HashSet<String>>,
    error: Option<ValidationError>,
}

impl ProjectScopeRewriter {
    fn new(project_id: &str) -> Self {
        Self {
            project_id: project_id.to_string(),
            allowed: ALLOWED_TABLES.into_iter().collect(),
            cte_scopes: Vec::new(),
            error: None,
        }
    }

    fn is_known_cte(&self, name: &str) -> bool {
        self.cte_scopes.iter().any(|scope| scope.contains(name))
    }
}

impl VisitorMut for ProjectScopeRewriter {
    type Break = ();

    fn pre_visit_query(&mut self, query: &mut Query) -> ControlFlow<()> {
        if query.settings.is_some() {
            self.error = Some(ValidationError::SettingsClausePresent);
            return ControlFlow::Break(());
        }

        let mut names = HashSet::new();
        if let Some(with) = &query.with {
            for cte in &with.cte_tables {
                names.insert(cte.alias.name.value.to_lowercase());
            }
        }
        self.cte_scopes.push(names);
        ControlFlow::Continue(())
    }

    fn post_visit_query(&mut self, _query: &mut Query) -> ControlFlow<()> {
        self.cte_scopes.pop();
        ControlFlow::Continue(())
    }

    fn post_visit_table_factor(&mut self, table_factor: &mut TableFactor) -> ControlFlow<()> {
        let TableFactor::Table { name, alias, .. } = table_factor else {
            return ControlFlow::Continue(());
        };

        // Reject schema/database-qualified references outright (`system.tables`,
        // `other_db.events`, etc.) — only a single bare identifier is allowed.
        if name.0.len() != 1 {
            self.error = Some(ValidationError::DisallowedTable(name.to_string()));
            return ControlFlow::Break(());
        }
        let table_name = match &name.0[0] {
            ObjectNamePart::Identifier(ident) => ident.value.clone(),
            _ => {
                self.error = Some(ValidationError::DisallowedTable(name.to_string()));
                return ControlFlow::Break(());
            }
        };
        let lower = table_name.to_lowercase();

        // A reference to an in-scope CTE name is not a physical table — leave
        // it untouched (the underlying table read was already scoped when the
        // CTE's own body was visited).
        if self.is_known_cte(&lower) {
            return ControlFlow::Continue(());
        }

        if !self.allowed.contains(lower.as_str()) {
            self.error = Some(ValidationError::DisallowedTable(table_name));
            return ControlFlow::Break(());
        }

        let alias_name = alias
            .as_ref()
            .map(|a| a.name.clone())
            .unwrap_or_else(|| Ident::new(table_name.clone()));

        // Re-parsing a tiny, fully-controlled SQL fragment is far simpler and
        // less error-prone than hand-building the (huge) `Select` struct
        // field-by-field. `table_name` is allowlist-checked above and
        // `project_id` passed `is_safe_project_id` before this visit started,
        // so nothing here is attacker-controlled text.
        let inner_sql = format!(
            "SELECT * FROM {table_name} WHERE project_id = '{}'",
            self.project_id
        );
        let inner_query = match Parser::parse_sql(&ClickHouseDialect {}, &inner_sql) {
            Ok(mut stmts) => match stmts.remove(0) {
                Statement::Query(q) => *q,
                _ => unreachable!("inner_sql is always a SELECT"),
            },
            Err(e) => {
                self.error = Some(ValidationError::ParseError(e.to_string()));
                return ControlFlow::Break(());
            }
        };

        *table_factor = TableFactor::Derived {
            lateral: false,
            subquery: Box::new(inner_query),
            alias: Some(TableAlias {
                name: alias_name,
                columns: vec![],
                explicit: true,
                at: None,
            }),
            sample: None,
        };

        ControlFlow::Continue(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PID: &str = "proj_abc123";

    #[test]
    fn simple_select_is_allowed_and_rewritten() {
        let out = validate_and_rewrite("SELECT * FROM events", PID).unwrap();
        assert_eq!(
            out,
            format!("SELECT * FROM (SELECT * FROM events WHERE project_id = '{PID}') AS events")
        );
    }

    #[test]
    fn with_cte_is_allowed_and_underlying_table_rewritten() {
        let out =
            validate_and_rewrite("WITH x AS (SELECT * FROM events) SELECT * FROM x", PID).unwrap();
        assert_eq!(
            out,
            format!(
                "WITH x AS (SELECT * FROM (SELECT * FROM events WHERE project_id = '{PID}') AS events) SELECT * FROM x"
            )
        );
    }

    #[test]
    fn insert_is_rejected() {
        let err = validate_and_rewrite("INSERT INTO events (uuid) VALUES ('a')", PID).unwrap_err();
        assert_eq!(err, ValidationError::NotAQuery);
    }

    #[test]
    fn drop_table_is_rejected() {
        let err = validate_and_rewrite("DROP TABLE events", PID).unwrap_err();
        assert_eq!(err, ValidationError::NotAQuery);
    }

    #[test]
    fn alter_table_is_rejected() {
        let err = validate_and_rewrite("ALTER TABLE events ADD COLUMN x String", PID).unwrap_err();
        assert_eq!(err, ValidationError::NotAQuery);
    }

    #[test]
    fn set_statement_is_rejected() {
        let err = validate_and_rewrite("SET max_threads = 100", PID).unwrap_err();
        assert_eq!(err, ValidationError::NotAQuery);
    }

    #[test]
    fn multi_statement_is_rejected() {
        let err = validate_and_rewrite("SELECT 1; DROP TABLE events", PID).unwrap_err();
        assert_eq!(err, ValidationError::MultiStatement);
    }

    #[test]
    fn system_table_is_rejected() {
        let err = validate_and_rewrite("SELECT * FROM system.tables", PID).unwrap_err();
        assert_eq!(
            err,
            ValidationError::DisallowedTable("system.tables".to_string())
        );
    }

    #[test]
    fn rewrite_injects_project_id_for_all_allowlisted_tables() {
        for table in ALLOWED_TABLES {
            let out = validate_and_rewrite(&format!("SELECT * FROM {table}"), PID).unwrap();
            assert!(
                out.contains(&format!("WHERE project_id = '{PID}'")),
                "expected project_id predicate injected for {table}, got: {out}"
            );
        }
    }

    #[test]
    fn constant_only_select_with_no_table_is_allowed_unchanged() {
        let out = validate_and_rewrite("SELECT 1", PID).unwrap();
        assert_eq!(out, "SELECT 1");
    }

    #[test]
    fn settings_clause_is_rejected() {
        let err = validate_and_rewrite("SELECT * FROM events SETTINGS max_threads = 100", PID)
            .unwrap_err();
        assert_eq!(err, ValidationError::SettingsClausePresent);
    }

    #[test]
    fn join_across_allowlisted_tables_rewrites_both_sides() {
        let out = validate_and_rewrite(
            "SELECT * FROM events e JOIN flag_events f ON e.uuid = f.uuid",
            PID,
        )
        .unwrap();
        assert!(out.matches(&format!("WHERE project_id = '{PID}'")).count() == 2);
    }

    #[test]
    fn unsafe_project_id_is_rejected() {
        let err =
            validate_and_rewrite("SELECT * FROM events", "proj'; DROP TABLE x --").unwrap_err();
        assert_eq!(err, ValidationError::InvalidProjectId);
    }
}
