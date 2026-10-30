//! Survey config delivery. A plain, static Postgres read of
//! the ACTIVE surveys for a project — definition + linked flag key. There is
//! **no** server-side eligibility eval here: the SDK already holds the evaluated
//! flags from `/v1/flags` and gates display on `isFeatureEnabled(linkedFlagKey)`.

pub mod endpoint;
pub mod store;
