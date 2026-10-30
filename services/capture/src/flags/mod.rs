//! Feature-flag evaluation. Parity with the JS SDK and TS server is
//! enforced by the shared fixture in [`eval`]'s tests.

pub mod endpoint_defs;
pub mod endpoint_flags;
pub mod endpoint_version;
pub mod eval;
pub mod hash;
pub mod property;
pub mod store;
