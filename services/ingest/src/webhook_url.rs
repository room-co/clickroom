//! Outbound URL admission for support-webhook delivery (the SSRF guard).
//!
//! keep in sync with `admitWebhookUrl` / `isPrivateAddress` in
//! `packages/trpc-router/src/trpc/routers/support.webhook-signing.ts` (and its
//! test file, `support.webhook-signing.test.ts`). The accept/reject table in
//! [`tests`] below mirrors that suite's table row for row, so either side
//! drifting fails loudly rather than leaving one of the two send paths open.
//!
//! There are two send paths and they must agree on "an endpoint we are willing
//! to POST to": the synchronous `webhooks.sendTest` (TypeScript) and
//! the asynchronous delivery worker ([`crate::webhook_job`], Rust). A customer
//! types the URL, so both are user-driven outbound fetches from a host that can
//! reach the internal network — textbook SSRF reach.
//!
//! The check is HTTPS-only plus "every address this host resolves to is public".
//! DNS is resolved *here* rather than left to `reqwest` because the question is
//! where the request lands, not what the string looks like: a perfectly public
//! hostname with an `A` record of `127.0.0.1` is the whole attack. Every
//! returned address is checked, not just the first, since the client may pick
//! any of them.
//!
//! NOTE: this is resolve-then-connect, so a resolver that answers differently on
//! `reqwest`'s own lookup (DNS rebinding) is not covered. Closing that needs the
//! admitted address pinned at connect time. Same risk the TS guard accepts.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use url::{Host, Url};

/// Why an endpoint URL was refused.
///
/// Mirrors the TS `WebhookUrlRejection` union
/// (`invalid_url` | `not_https` | `no_host` | `unresolvable` | `private_address`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UrlRejection {
    InvalidUrl,
    NotHttps,
    NoHost,
    Unresolvable(String),
    PrivateAddress,
}

impl fmt::Display for UrlRejection {
    /// The text that lands in `SupportWebhookAttempt.errorMessage` /
    /// `SupportWebhookDelivery.lastError`. Kept identical to the TS guard's
    /// `message` strings so a customer sees the same sentence whether the URL
    /// was refused by Send test or by the worker six hours later.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUrl => write!(f, "Endpoint URL is not a valid URL"),
            Self::NotHttps => write!(f, "Endpoint URL must be https://"),
            Self::NoHost => write!(f, "Endpoint URL has no host"),
            Self::Unresolvable(host) => write!(f, "Could not resolve {host}"),
            Self::PrivateAddress => {
                write!(f, "Endpoint URL resolves to a private or loopback address")
            }
        }
    }
}

/// What the URL's host turned out to be once parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Target {
    /// An IP literal in the URL — it never reaches the resolver.
    Literal(IpAddr),
    /// A hostname that still has to be resolved, with the port to resolve it on.
    Name(String, u16),
}

/// An admitted URL and the addresses it was admitted on (the latter is what a
/// future connect-time pin would use).
#[derive(Debug, Clone)]
pub struct AdmittedUrl {
    pub addresses: Vec<IpAddr>,
}

/// Parse `raw` and apply every check that needs no DNS: valid URL, `https:`,
/// a host, and — for an IP literal — that the address is public.
///
/// Split out from [`admit_webhook_url`] so the accept/reject table can be
/// tested without a resolver, the way the TS suite injects one.
fn parse_target(raw: &str, allow_private: bool) -> Result<Target, UrlRejection> {
    // Fail closed: anything `url` will not parse is refused rather than passed
    // to `reqwest` to interpret some other way.
    let url = Url::parse(raw).map_err(|_| UrlRejection::InvalidUrl)?;

    if url.scheme() != "https" {
        return Err(UrlRejection::NotHttps);
    }

    // `Url::host` is already the unbracketed host, and it tells us whether it
    // is an IP literal — no separate `isIP` pass, and `https://[::1]/hook`
    // arrives here as an `Ipv6` variant rather than the string `[::1]`.
    let host = url.host().ok_or(UrlRejection::NoHost)?;
    let literal = match host {
        Host::Domain("") => return Err(UrlRejection::NoHost),
        Host::Domain(name) => {
            // 443 when the URL omits it; only used as the resolver's port.
            let port = url.port_or_known_default().unwrap_or(443);
            return Ok(Target::Name(name.to_string(), port));
        }
        Host::Ipv4(v4) => IpAddr::V4(v4),
        Host::Ipv6(v6) => IpAddr::V6(v6),
    };

    check_addresses(&[literal], allow_private)?;
    Ok(Target::Literal(literal))
}

/// Every resolved address must be public. Empty means the host resolved to
/// nothing, which is `unresolvable`, not an accept.
fn check_addresses(addresses: &[IpAddr], allow_private: bool) -> Result<(), UrlRejection> {
    if allow_private {
        return Ok(());
    }
    if addresses.iter().any(is_private_address) {
        return Err(UrlRejection::PrivateAddress);
    }
    Ok(())
}

/// True for any address a customer webhook must never be pointed at.
///
/// keep in sync with `isPrivateAddress` in
/// `packages/trpc-router/src/trpc/routers/support.webhook-signing.ts`.
pub fn is_private_address(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => is_private_ipv4(v4),
        IpAddr::V6(v6) => is_private_ipv6(v6),
    }
}

/// RFC1918 / loopback / link-local / CGNAT / multicast / broadcast / "this
/// network". Anything not routable on the public internet is refused: the point
/// is that a customer-supplied URL must not reach anything the ingest host can
/// reach and the public cannot.
///
/// keep in sync with `isPrivateIpv4` in `support.webhook-signing.ts` — the
/// ranges are enumerated in the same order for exactly that reason.
fn is_private_ipv4(address: &Ipv4Addr) -> bool {
    let [a, b, ..] = address.octets();
    match (a, b) {
        (0, _) => true,                // 0.0.0.0/8 "this network"
        (10, _) => true,               // RFC1918
        (127, _) => true,              // loopback
        (169, 254) => true,            // link-local (incl. cloud metadata 169.254.169.254)
        (172, 16..=31) => true,        // RFC1918
        (192, 168) => true,            // RFC1918
        (100, 64..=127) => true,       // CGNAT RFC6598
        (192, 0) => true,              // IETF protocol assignments
        (198, 18) | (198, 19) => true, // benchmarking RFC2544
        (a, _) if a >= 224 => true,    // multicast, reserved, 255.255.255.255
        _ => false,
    }
}

/// Loopback `::1`, unspecified `::`, ULA `fc00::/7`, link-local `fe80::/10`,
/// multicast `ff00::/8`, and IPv4-mapped / IPv4-compatible forms judged by the
/// address they embed.
///
/// keep in sync with `isPrivateIpv6` in `support.webhook-signing.ts`. The TS
/// side finds the embedded v4 by matching a trailing dotted quad on the *text*;
/// here it is `Ipv6Addr::to_ipv4`, which covers `::a.b.c.d` and
/// `::ffff:a.b.c.d` in every spelling. `::1` and `::` fall through it as
/// `0.0.0.1` / `0.0.0.0`, both caught by the `0.0.0.0/8` arm above — same
/// verdict the TS literal comparisons reach.
fn is_private_ipv6(address: &Ipv6Addr) -> bool {
    if let Some(embedded) = address.to_ipv4() {
        return is_private_ipv4(&embedded);
    }
    let leading = address.segments()[0];
    (leading & 0xfe00) == 0xfc00 // fc00::/7 unique-local
        || (leading & 0xffc0) == 0xfe80 // fe80::/10 link-local
        || (leading & 0xff00) == 0xff00 // ff00::/8 multicast
}

/// URL admission for an outbound webhook POST: HTTPS only, and every address
/// the host resolves to must be public.
///
/// `allow_private` is the `INGEST_WEBHOOK_ALLOW_PRIVATE_TARGETS` escape hatch
/// (default **false**). It exists because local development posts to a
/// localhost receiver; it disables *only* the address check, never the
/// HTTPS/parse checks, so a dev box cannot accidentally run a materially
/// different guard.
///
/// keep in sync with `admitWebhookUrl` in
/// `packages/trpc-router/src/trpc/routers/support.webhook-signing.ts` (and its
/// test file, `support.webhook-signing.test.ts`).
pub async fn admit_webhook_url(
    raw: &str,
    allow_private: bool,
) -> Result<AdmittedUrl, UrlRejection> {
    let (host, port) = match parse_target(raw, allow_private)? {
        Target::Literal(address) => {
            return Ok(AdmittedUrl {
                addresses: vec![address],
            })
        }
        Target::Name(host, port) => (host, port),
    };

    let addresses = resolve(&host, port).await?;
    check_addresses(&addresses, allow_private)?;
    Ok(AdmittedUrl { addresses })
}

/// Resolve a hostname to every address it answers with. A lookup error and an
/// empty answer are the same rejection — neither is an accept.
async fn resolve(host: &str, port: u16) -> Result<Vec<IpAddr>, UrlRejection> {
    let resolved = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| UrlRejection::Unresolvable(host.to_string()))?;
    let addresses: Vec<IpAddr> = resolved.map(|socket| socket.ip()).collect();
    if addresses.is_empty() {
        return Err(UrlRejection::Unresolvable(host.to_string()));
    }
    Ok(addresses)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(address: &str) -> IpAddr {
        address.parse().expect("test address parses")
    }

    /// The reject half of the TS `isPrivateAddress` table.
    #[test]
    fn rejects_every_non_public_address() {
        for address in [
            "127.0.0.1",
            "127.9.9.9",
            "10.1.2.3",
            "172.16.0.1",
            "172.20.5.5",
            "172.31.255.255",
            "192.168.0.10",
            "169.254.169.254", // cloud metadata
            "169.254.0.1",
            "100.64.0.1", // CGNAT
            "100.127.255.255",
            "0.0.0.0",
            "192.0.0.1",
            "198.18.0.1",
            "198.19.0.1",
            "224.0.0.1", // multicast
            "255.255.255.255",
            "::1",              // IPv6 loopback
            "::",               // unspecified
            "fd00::1",          // ULA
            "fc00::1",          // ULA
            "fe80::abcd",       // link-local
            "ff02::1",          // multicast
            "::ffff:127.0.0.1", // IPv4-mapped loopback
            "::ffff:10.0.0.1",  // IPv4-mapped RFC1918
        ] {
            assert!(
                is_private_address(&ip(address)),
                "{address} must never be an admitted webhook target"
            );
        }
    }

    /// The accept half. A guard that rejects everything is not a guard.
    #[test]
    fn accepts_public_addresses() {
        for address in [
            "93.184.216.34",
            "8.8.8.8",
            "1.1.1.1",
            "172.32.0.1", // just outside RFC1918
            "172.15.0.1",
            "100.63.255.255", // just outside CGNAT
            "100.128.0.1",
            "192.169.0.1",
            "198.20.0.1",
            "223.255.255.255", // just below multicast
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
        ] {
            assert!(
                !is_private_address(&ip(address)),
                "{address} is public and must be admitted"
            );
        }
    }

    #[test]
    fn rejects_a_non_url_string() {
        assert_eq!(parse_target("nope", false), Err(UrlRejection::InvalidUrl));
        assert_eq!(parse_target("", false), Err(UrlRejection::InvalidUrl));
    }

    /// The scheme is checked before anything resolves, so plain `http://` never
    /// reaches DNS at all.
    #[test]
    fn rejects_non_https_schemes() {
        assert_eq!(
            parse_target("http://hooks.example.com/inbound", false),
            Err(UrlRejection::NotHttps)
        );
        assert_eq!(
            parse_target("ftp://hooks.example.com/inbound", false),
            Err(UrlRejection::NotHttps)
        );
        // Even with the dev flag on: the escape hatch relaxes addresses only.
        assert_eq!(
            parse_target("http://localhost:4000/hook", true),
            Err(UrlRejection::NotHttps)
        );
    }

    /// An IP literal is judged in place and never consults the resolver.
    #[test]
    fn rejects_private_ip_literals_without_dns() {
        for raw in [
            "https://127.0.0.1:8443/hook",
            "https://10.0.0.5/hook",
            "https://169.254.169.254/latest/meta-data",
            "https://[::1]/hook",
            "https://[fd00::1]/hook",
        ] {
            assert_eq!(
                parse_target(raw, false),
                Err(UrlRejection::PrivateAddress),
                "{raw} must be refused as a literal"
            );
        }
    }

    #[test]
    fn accepts_a_public_ip_literal_and_a_public_hostname() {
        assert_eq!(
            parse_target("https://93.184.216.34/hook", false),
            Ok(Target::Literal(ip("93.184.216.34")))
        );
        assert_eq!(
            parse_target("https://hooks.example.com/inbound", false),
            Ok(Target::Name("hooks.example.com".to_string(), 443))
        );
        // An explicit port is carried through to the resolver.
        assert_eq!(
            parse_target("https://hooks.example.com:8443/inbound", false),
            Ok(Target::Name("hooks.example.com".to_string(), 8443))
        );
    }

    /// A public hostname whose answer contains a private address is refused —
    /// and refused if *any* address is private, not just the first, because the
    /// client may connect to any of them.
    #[test]
    fn rejects_when_any_resolved_address_is_private() {
        assert_eq!(check_addresses(&[ip("93.184.216.34")], false), Ok(()));
        assert_eq!(
            check_addresses(&[ip("93.184.216.34"), ip("127.0.0.1")], false),
            Err(UrlRejection::PrivateAddress)
        );
        assert_eq!(
            check_addresses(&[ip("169.254.169.254")], false),
            Err(UrlRejection::PrivateAddress)
        );
    }

    /// `INGEST_WEBHOOK_ALLOW_PRIVATE_TARGETS=true` flips exactly one thing: the
    /// address check. Default false, so production is safe without setting it.
    #[test]
    fn the_dev_flag_flips_only_the_address_check() {
        // Rejected by default…
        assert_eq!(
            parse_target("https://127.0.0.1:4000/hook", false),
            Err(UrlRejection::PrivateAddress)
        );
        assert_eq!(
            check_addresses(&[ip("127.0.0.1")], false),
            Err(UrlRejection::PrivateAddress)
        );
        // …admitted with the flag on.
        assert_eq!(
            parse_target("https://127.0.0.1:4000/hook", true),
            Ok(Target::Literal(ip("127.0.0.1")))
        );
        assert_eq!(check_addresses(&[ip("127.0.0.1")], true), Ok(()));
        // But a malformed URL is still refused with the flag on: the hatch is
        // not a bypass of the whole guard.
        assert_eq!(parse_target("nope", true), Err(UrlRejection::InvalidUrl));
    }

    /// `localhost` is a name, not a literal, so it is caught after resolution
    /// rather than in `parse_target` — the one case where the dev flag matters
    /// through the async path.
    #[tokio::test]
    async fn localhost_is_rejected_by_default_and_admitted_behind_the_flag() {
        let rejected = admit_webhook_url("https://localhost:4000/hook", false).await;
        assert_eq!(rejected.err(), Some(UrlRejection::PrivateAddress));

        let admitted = admit_webhook_url("https://localhost:4000/hook", true)
            .await
            .expect("the dev flag admits a localhost receiver");
        assert!(admitted.addresses.iter().all(|a| a.is_loopback()));
    }

    /// The error strings are customer-facing (`errorMessage` on the attempt
    /// row) and are the TS guard's `message` values verbatim.
    #[test]
    fn rejection_messages_match_the_ts_guard() {
        assert_eq!(
            UrlRejection::InvalidUrl.to_string(),
            "Endpoint URL is not a valid URL"
        );
        assert_eq!(
            UrlRejection::NotHttps.to_string(),
            "Endpoint URL must be https://"
        );
        assert_eq!(UrlRejection::NoHost.to_string(), "Endpoint URL has no host");
        assert_eq!(
            UrlRejection::PrivateAddress.to_string(),
            "Endpoint URL resolves to a private or loopback address"
        );
        assert_eq!(
            UrlRejection::Unresolvable("nx.example.com".to_string()).to_string(),
            "Could not resolve nx.example.com"
        );
    }
}
