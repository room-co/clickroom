//! Attachment upload policy + presigned S3 `PUT` URLs.
//!
//! Policy constants and helpers are a direct port of the reference implementation's
//! `apps/api/src/services/attachment.service.ts` (`ALLOWED_TYPES`, `MAX_BYTES`,
//! `PRESIGN_TTL_SECONDS`, `validateUploadRequest`, `sanitizeFilename`, and the
//! `S3_PUBLIC_ENDPOINT` override) so both products enforce the same rules.
//!
//! Two invariants worth stating out loud, because both are load-bearing
//! security properties rather than tidiness:
//!
//! - **The storage key is never client-derived.** It is
//!   `{project}/{ticket}/{ulid}-{sanitized}`: the project and ticket segments
//!   come from the authenticated write key and a validated id, the uniqueness
//!   comes from a server-minted ULID, and the client's filename survives only
//!   as a sanitized cosmetic suffix. A caller cannot choose where their bytes
//!   land, overwrite someone else's object, or traverse out of their prefix.
//! - **`S3_PUBLIC_ENDPOINT` exists because the browser, not capture-rs,
//!   follows the URL.** The host is baked into the SigV4 signature, so signing
//!   against an in-network endpoint the browser cannot resolve produces URLs
//!   that fail at upload time. Unset in prod (real S3 is already
//!   browser-reachable).

use std::time::Duration;

use aws_config::BehaviorVersion;
use aws_sdk_s3::{config::Region, presigning::PresigningConfig, Client};
use tokio::sync::OnceCell;

use crate::config::Config;

/// MIME types accepted for a support attachment.
pub const ALLOWED_TYPES: [&str; 7] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "application/pdf",
    "text/plain",
    "text/csv",
];

/// Maximum size of a single attachment (10 MiB).
pub const MAX_BYTES: i64 = 10 * 1024 * 1024;

/// Presigned URL time-to-live, in seconds. Short on purpose: the URL is a
/// bearer credential for writing one object, and the widget uses it
/// immediately.
pub const PRESIGN_TTL_SECONDS: u64 = 300;

/// A validated upload request: what the caller asked for, normalized.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedUpload {
    /// The resolved, lower-cased content type to sign and persist.
    pub content_type: String,
    /// The declared size in bytes.
    pub size_bytes: i64,
}

/// Lower-cased file extension (without the dot), or `""` when absent.
fn extension_of(filename: &str) -> String {
    let base = filename.rsplit(['/', '\\']).next().unwrap_or_default();
    match base.rfind('.') {
        Some(dot) => base[dot + 1..].to_ascii_lowercase(),
        None => String::new(),
    }
}

/// Resolve the effective content type.
///
/// A `.log` filename is always treated as `text/plain` regardless of the
/// (usually `application/octet-stream`) type the browser guessed. Returns
/// `None` when nothing can be resolved.
pub fn resolve_content_type(filename: &str, content_type: &str) -> Option<String> {
    if extension_of(filename) == "log" {
        return Some("text/plain".to_string());
    }
    // Strip any `; charset=…` parameter before matching the allow-list.
    let trimmed = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Enforce the MIME allow-list and the size cap.
pub fn validate_upload(
    filename: &str,
    content_type: &str,
    size_bytes: i64,
) -> Result<ValidatedUpload, String> {
    let resolved = resolve_content_type(filename, content_type)
        .ok_or_else(|| "attachment content type is missing".to_string())?;
    if !ALLOWED_TYPES.contains(&resolved.as_str()) {
        return Err(format!("unsupported attachment type: {resolved}"));
    }
    if size_bytes <= 0 {
        return Err("attachment size must be greater than zero".to_string());
    }
    if size_bytes > MAX_BYTES {
        return Err(format!("attachment exceeds the {MAX_BYTES}-byte limit"));
    }
    Ok(ValidatedUpload {
        content_type: resolved,
        size_bytes,
    })
}

/// Sanitize a client filename into a safe slug: strips every path component
/// (defeating traversal), lower-cases, and keeps only `[a-z0-9.]`. Never
/// trusted in the key — cosmetic suffix only.
pub fn sanitize_filename(filename: &str) -> String {
    let base = filename.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut slug = String::with_capacity(base.len());
    let mut last_was_dash = false;
    for ch in base.to_ascii_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '.' {
            slug.push(ch);
            last_was_dash = false;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }
    let trimmed = slug.trim_matches(['-', '.']);
    if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Whether an id is safe to embed as a single key segment: ULIDs and the
/// literal `unassigned` placeholder only. Rejects anything with a separator,
/// a dot, or non-alphanumeric bytes, so a caller can never widen their own
/// prefix through the ticket id.
pub fn is_safe_key_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 64
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !segment.starts_with('-')
}

/// Placeholder ticket segment for an attachment uploaded *before* its ticket
/// exists — the widget presigns while the user is still filling the form.
pub const UNASSIGNED_TICKET_SEGMENT: &str = "unassigned";

/// Build the object key: `{project}/{ticket}/{ulid}-{sanitized filename}`.
///
/// `unique` is a server-minted ULID; the caller passes it in rather than the
/// function minting one so the key is a pure function of its inputs and can be
/// asserted exactly in tests.
pub fn build_attachment_key(
    project_id: &str,
    ticket_segment: &str,
    unique: &str,
    filename: &str,
) -> String {
    format!(
        "{project_id}/{ticket_segment}/{unique}-{}",
        sanitize_filename(filename)
    )
}

/// Process-wide S3 client, built once on the first presign request.
///
/// Lazily initialized rather than built at boot because the credential
/// provider chain does I/O (IMDS/ECS metadata in prod) and a deployment with
/// support unused should not pay for it — nor fail to start because of it.
static S3_CLIENT: OnceCell<Client> = OnceCell::const_new();

/// Build the S3 client from config: the default provider chain (static env
/// credentials against LocalStack in dev, the ECS task role in prod) plus the
/// endpoint / path-style overrides.
async fn build_client(config: &Config) -> Client {
    let shared = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(config.aws_region.clone()))
        .load()
        .await;
    let mut builder = aws_sdk_s3::config::Builder::from(&shared);
    // Presigned URLs are followed by the browser, so prefer the public
    // endpoint; fall back to the in-network one when they are the same host.
    if let Some(endpoint) = config
        .s3_public_endpoint
        .as_ref()
        .or(config.s3_endpoint.as_ref())
    {
        builder = builder.endpoint_url(endpoint);
    }
    builder = builder.force_path_style(config.s3_force_path_style);
    Client::from_conf(builder.build())
}

/// Presign a `PUT` for `key`.
///
/// Both the content type **and** the content length are signed, so the upload
/// the browser actually performs is pinned to the size the caller declared and
/// this endpoint validated — otherwise `MAX_BYTES` would be advisory, enforced
/// only against a number the client made up.
pub async fn presign_put(
    config: &Config,
    key: &str,
    upload: &ValidatedUpload,
) -> anyhow::Result<String> {
    let bucket = config
        .support_attachments_bucket
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("SUPPORT_ATTACHMENTS_BUCKET is not configured"))?;
    let client = S3_CLIENT
        .get_or_init(|| async { build_client(config).await })
        .await;
    let presigning = PresigningConfig::expires_in(Duration::from_secs(PRESIGN_TTL_SECONDS))?;
    let request = client
        .put_object()
        .bucket(bucket)
        .key(key)
        .content_type(&upload.content_type)
        .content_length(upload.size_bytes)
        .presigned(presigning)
        .await?;
    Ok(request.uri().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_every_allowlisted_type() {
        for mime in ALLOWED_TYPES {
            let out = validate_upload("shot.png", mime, 1024).expect(mime);
            assert_eq!(out.content_type, mime);
        }
    }

    #[test]
    fn normalizes_case_and_charset_parameter() {
        let out = validate_upload("notes.txt", "TEXT/Plain; charset=UTF-8", 10).unwrap();
        assert_eq!(out.content_type, "text/plain");
    }

    #[test]
    fn log_files_are_forced_to_text_plain() {
        let out = validate_upload("server.LOG", "application/octet-stream", 10).unwrap();
        assert_eq!(out.content_type, "text/plain");
    }

    #[test]
    fn rejects_disallowed_mime_types() {
        for mime in [
            "application/zip",
            "text/html",
            "image/svg+xml",
            "application/octet-stream",
            "application/x-msdownload",
        ] {
            assert!(
                validate_upload("payload.bin", mime, 10).is_err(),
                "{mime} must be rejected"
            );
        }
    }

    #[test]
    fn rejects_missing_content_type() {
        assert!(validate_upload("shot.png", "   ", 10).is_err());
    }

    #[test]
    fn enforces_the_size_cap_at_the_boundary() {
        assert!(validate_upload("a.png", "image/png", MAX_BYTES).is_ok());
        assert!(validate_upload("a.png", "image/png", MAX_BYTES + 1).is_err());
        assert!(validate_upload("a.png", "image/png", 0).is_err());
        assert!(validate_upload("a.png", "image/png", -1).is_err());
    }

    #[test]
    fn sanitizes_filenames() {
        assert_eq!(sanitize_filename("Screen Shot.PNG"), "screen-shot.png");
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("C:\\Users\\me\\a b.txt"), "a-b.txt");
        assert_eq!(sanitize_filename("...."), "file");
        assert_eq!(sanitize_filename(""), "file");
        assert_eq!(sanitize_filename("🙂🙂"), "file");
    }

    #[test]
    fn key_is_server_derived_and_traversal_proof() {
        let key = build_attachment_key(
            "01PROJECT",
            "01TICKET",
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "../../../etc/passwd",
        );
        assert_eq!(key, "01PROJECT/01TICKET/01ARZ3NDEKTSV4RRFFQ69G5FAV-passwd");
        assert!(!key.contains(".."));
        assert_eq!(key.matches('/').count(), 2);
    }

    #[test]
    fn key_uniqueness_comes_from_the_server_ulid_not_the_filename() {
        let a = build_attachment_key("p", "t", "01AAA", "shot.png");
        let b = build_attachment_key("p", "t", "01BBB", "shot.png");
        assert_ne!(a, b);
    }

    #[test]
    fn key_segments_reject_traversal_and_separators() {
        assert!(is_safe_key_segment("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
        assert!(is_safe_key_segment(UNASSIGNED_TICKET_SEGMENT));
        for bad in ["../other", "a/b", "a.b", "", "-lead", "a b", "a\\b"] {
            assert!(!is_safe_key_segment(bad), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn presign_ttl_is_short_and_accepted_by_the_sdk() {
        // A presigned URL is a bearer credential for writing one object, so the
        // TTL stays minutes, not hours. Building the real `PresigningConfig`
        // also proves the constant is inside the SDK's accepted range (it
        // rejects anything over a week) rather than only asserting a literal.
        const { assert!(PRESIGN_TTL_SECONDS <= 900) };
        assert!(PresigningConfig::expires_in(Duration::from_secs(PRESIGN_TTL_SECONDS)).is_ok());
    }
}
