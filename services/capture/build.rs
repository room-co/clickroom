//! Bakes the browser SDK bundle (`packages/sdk-js/dist/clickroom.js`) into the
//! capture binary at compile time, so `GET /static/clickroom.js` can be served
//! straight out of `.rodata` (see `src/sdk.rs`).
//!
//! Why compile-time rather than `tower_http::services::ServeFile`:
//!   * the runtime image is distroless (`services/capture/Dockerfile`) and copies
//!     *only* the stripped binary — there is no filesystem to serve from, and
//!     adding one would mean a second COPY, a second thing to get wrong on
//!     deploy, and the `tower-http/fs` feature;
//!   * a missing file then becomes a 404 at 3am instead of a build-time signal.
//!
//! The awkward part is that a bare `cargo build` / `cargo test` on a dev machine
//! (and `cargo chef cook`, which compiles against dummy sources) runs with no SDK
//! `dist/` present — `pnpm --filter @clickroom/sdk-js build` may simply never have
//! been run. `include_str!` of a missing path is a hard compile error, so instead
//! of pointing at the workspace file directly we always materialise a file in
//! `OUT_DIR`: the real bundle when it exists, an obviously-marked placeholder when
//! it doesn't. The build never fails; the *binary* tells you which one it got via
//! `CLICKROOM_SDK_BUNDLE_PRESENT` (asserted at startup — `main.rs` logs a warning,
//! and the served body carries a comment saying so). A silently-empty SDK served
//! with a 200 would be far worse to debug than a 404.

use std::{env, fs, path::PathBuf};

/// Repo-relative location of the esbuild output (see
/// `packages/sdk-js/esbuild.config.mjs` — minified IIFE, entry `src/global.ts`).
/// Relative to this crate root (`services/capture`).
const SDK_BUNDLE_RELATIVE: &str = "../../packages/sdk-js/dist/clickroom.js";

/// Served (and logged about) when the bundle is absent. Valid JavaScript, so a
/// misbuilt image degrades to "SDK does nothing, console says why" rather than a
/// syntax error inside every customer's page.
const PLACEHOLDER: &str = concat!(
    "/* clickroom SDK bundle MISSING at build time. This capture binary was\n",
    "   compiled without packages/sdk-js/dist/clickroom.js — see\n",
    "   services/capture/build.rs. Rebuild the image (the Dockerfile's node\n",
    "   stage runs the SDK build) or run `pnpm --filter @clickroom/sdk-js build`. */\n",
    "console.error('[clickroom] SDK bundle was not compiled into the capture service.');\n"
);

fn main() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR set by cargo"));
    let dest = out_dir.join("clickroom.js");

    // An explicit override wins — the Docker build stages the bundle at a path of
    // its own choosing rather than reconstructing the pnpm workspace layout.
    let source = match env::var("CLICKROOM_SDK_BUNDLE") {
        Ok(p) => PathBuf::from(p),
        Err(_) => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(SDK_BUNDLE_RELATIVE),
    };

    println!("cargo:rerun-if-env-changed=CLICKROOM_SDK_BUNDLE");
    println!("cargo:rerun-if-changed=build.rs");
    // Cargo honours this for a path that does not exist yet: the script re-runs
    // once the file appears (i.e. after the SDK is built, or after the Docker
    // builder stage copies it in on top of a cargo-chef-cooked layer).
    println!("cargo:rerun-if-changed={}", source.display());

    match fs::read(&source) {
        Ok(bytes) => {
            write_if_changed(&dest, &bytes);
            println!("cargo:rustc-env=CLICKROOM_SDK_BUNDLE_PRESENT=1");
        }
        Err(_) => {
            write_if_changed(&dest, PLACEHOLDER.as_bytes());
            println!("cargo:rustc-env=CLICKROOM_SDK_BUNDLE_PRESENT=0");
            println!(
                "cargo:warning=SDK bundle not found at {} — /static/clickroom.js will serve a placeholder. Run `pnpm --filter @clickroom/sdk-js build`.",
                source.display()
            );
        }
    }
}

/// Only touches `dest`'s mtime when its content actually changes. `cargo:rerun-if-changed`
/// on `source` is itself mtime-based, so a tool that re-materializes an unchanged `source`
/// with a fresh mtime (e.g. turborepo restoring a cache hit) reruns this script on every
/// invocation regardless. Since `capture` pulls `dest` in via `include_str!`, an
/// unconditional `fs::write` here would bump *its* mtime too and cascade into cargo
/// recompiling/relinking the whole crate for a byte-identical bundle — which is exactly
/// what was happening on every `make up:release`, even with zero source changes.
fn write_if_changed(dest: &std::path::Path, bytes: &[u8]) {
    if fs::read(dest).ok().as_deref() == Some(bytes) {
        return;
    }
    fs::write(dest, bytes).expect("write SDK bundle to OUT_DIR");
}
