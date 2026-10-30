//! `GET /static/clickroom.js` — the browser SDK bundle.
//!
//! Why capture serves this at all. The install snippet customers paste into their
//! `<head>` (`packages/sdk-js/loader.js`) injects
//! `<script src="{api_host}/static/clickroom.js">` — the *same* host the SDK then
//! POSTs events to. That host==api_host coupling is the contract: one value to
//! configure, one origin to allowlist in a CSP, and no way for the loader and the
//! ingest endpoint to drift apart. capture (`capture.clickroom.co`) is that host,
//! so capture has to answer this path. There is no CDN in front of capture yet —
//! the load-balancer rule matches on host header only, so
//! every path on that host already reaches this service and no infra change is
//! needed. If a CDN is ever put in front, it caches this response and nothing here
//! changes.
//!
//! The bytes are baked into the binary by `build.rs` (see that file for why not
//! `ServeFile`), which guarantees the route exists even when the SDK build was
//! skipped — it then serves a loud placeholder rather than failing to compile.
//!
//! This route deliberately lives at the router root, NOT under the `/v1` nest:
//! the loader has no version segment in its URL and the bundle is versioned by
//! deploy, not by path.

use axum::{
    http::{
        header::{CACHE_CONTROL, CONTENT_TYPE},
        StatusCode,
    },
    response::IntoResponse,
};

/// The esbuild IIFE bundle, embedded at compile time. Either the real
/// `packages/sdk-js/dist/clickroom.js` or `build.rs`'s placeholder.
const BUNDLE: &str = include_str!(concat!(env!("OUT_DIR"), "/clickroom.js"));

/// `"1"` when the real bundle was compiled in, `"0"` when the placeholder was.
/// Set by `build.rs` via `cargo:rustc-env`.
const BUNDLE_PRESENT: &str = env!("CLICKROOM_SDK_BUNDLE_PRESENT");

/// Whether this binary carries the real SDK bundle. `main.rs` warns loudly at
/// startup when it does not, so a misbuilt image is diagnosable from the logs
/// instead of from a customer reporting silently-missing analytics.
pub fn bundle_is_real() -> bool {
    BUNDLE_PRESENT == "1"
}

/// The URL is NOT content-addressed — a deploy changes the bytes behind the same
/// path — so an `immutable`/1-year TTL would pin browsers to a stale SDK with no
/// way to bust it. 5 minutes is the trade: long enough that a repeat visitor's
/// page load doesn't re-fetch the bundle on every navigation, short enough that a
/// bugfix (or a flag-eval change) reaches every browser within one coffee break
/// of the deploy finishing. Revisit if/when the loader starts requesting a
/// versioned path (e.g. `/static/clickroom.<hash>.js`), at which point this
/// should become `immutable`.
const CACHE_CONTROL_VALUE: &str = "public, max-age=300";

/// Serve the bundle. No state, no auth: it is public static JavaScript, identical
/// for every project (the write key is supplied by the customer's own `init()`
/// call, not baked in here).
///
/// The CORS layer in `main.rs` wraps this route, so a cross-origin `<script>` tag
/// — and any `fetch()`-based loader a customer might write instead — gets the
/// mirrored `Access-Control-Allow-Origin` it needs.
pub async fn sdk_bundle() -> impl IntoResponse {
    (
        StatusCode::OK,
        [
            // charset is explicit: without it a browser applies its default
            // encoding, which mangles any non-ASCII byte in the minified output.
            (CONTENT_TYPE, "application/javascript; charset=utf-8"),
            (CACHE_CONTROL, CACHE_CONTROL_VALUE),
        ],
        BUNDLE,
    )
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{header, Request, StatusCode},
        routing::get,
        Router,
    };
    use tower::ServiceExt as _;

    use super::{sdk_bundle, BUNDLE};

    fn router() -> Router {
        Router::new().route("/static/clickroom.js", get(sdk_bundle))
    }

    #[tokio::test]
    async fn serves_bundle_with_javascript_content_type() {
        let res = router()
            .oneshot(
                Request::builder()
                    .uri("/static/clickroom.js")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/javascript; charset=utf-8"
        );
        assert_eq!(
            res.headers().get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=300"
        );
    }

    /// Whether the real bundle or the placeholder is embedded depends on whether
    /// the SDK was built (a bare `cargo test` on a dev machine may have neither),
    /// so this asserts only the invariant that holds in BOTH cases: the body is
    /// never empty. An empty 200 is the one failure mode worse than a 404 — the
    /// loader's `onload` fires, nothing is installed, and the page looks fine.
    #[tokio::test]
    async fn bundle_body_is_never_empty() {
        let res = router()
            .oneshot(
                Request::builder()
                    .uri("/static/clickroom.js")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(!body.is_empty());
        assert_eq!(body.as_ref(), BUNDLE.as_bytes());
    }
}
