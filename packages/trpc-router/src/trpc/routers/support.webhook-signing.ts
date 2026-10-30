/**
 * Support webhook signing + outbound URL admission.
 *
 * The signing algorithm shipped in as Rust only
 * (`services/ingest/src/webhook_job.rs`, the async delivery worker).
 * synchronous `webhooks.sendTest` has to sign from Node before any row exists,
 * so the algorithm now has two implementations. They are kept honest by an
 * identical fixed vector pinned in both suites — see `signWebhookBody` below.
 *
 * The URL-admission guard lives here too so the sync (`sendTest`) and async
 * (worker) send paths share one definition of "an endpoint we are willing to
 * POST to". had no guard on either path; that was a pre-existing SSRF
 * hole, not a regression introduced here.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Lowercase hex HMAC-SHA256 over the Stripe-style signed payload
 * `<timestamp>.<raw body>`, keyed by the webhook's plaintext secret (its UTF-8
 * bytes, i.e. the string the customer was shown at create time — not its hex
 * decoding).
 *
 * The timestamp is inside the MAC deliberately: signing the body alone would
 * leave `t` attacker-controlled, and the freshness check every customer is told
 * to perform would then be enforcing a number the attacker picked.
 *
 * KEEP IN SYNC WITH `sign_body` in `services/ingest/src/webhook_job.rs:516`.
 * Both sides pin the identical vector: the Rust test is
 * `signs_the_known_vector` (`services/ingest/src/webhook_job.rs:533`), the TS
 * one is `signs the known cross-language vector` in
 * `support.webhook-signing.test.ts`. Either implementation drifting fails one
 * of the two loudly.
 */
export function signWebhookBody(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

/**
 * The `X-Clickroom-Signature` value.
 *
 * Outside a rotation grace window this is exactly what shipped and
 * what every customer's verification snippet parses:
 *
 * ```
 * t=<unix>,v1=<HMAC current>
 * ```
 *
 * During a grace window the *previous* secret keeps `v1` and the new one is
 * added as `v2`:
 *
 * ```
 * t=<unix>,v1=<HMAC previous>,v2=<HMAC current>
 * ```
 *
 * Not Stripe's dual-`v1`. Stripe emits two `v1=` values and expects the
 * receiver to accept if *any* matches; a hand-written verifier that splits on
 * `,v1=` and takes one value — which is what almost every hand-written verifier
 * does — picks one at random and rejects the other. Under dual-`v1` rotating a
 * secret (a *security* action) would cause a silent 24-hour outage for those
 * customers. Under `v1`=previous / `v2`=current, every naive single-`v1`
 * verifier keeps working untouched for the whole window, and by the time `v1`
 * flips to the new secret the customer has had a full day to deploy it.
 *
 * KEEP IN SYNC WITH `signature_header` in
 * `services/ingest/src/webhook_job.rs:504` (and its grace-window test).
 */
export function webhookSignatureHeader(
  secret: string,
  previous: { secret: string; expiresAt: Date } | null,
  timestamp: number,
  body: string,
): string {
  const current = signWebhookBody(secret, timestamp, body)
  if (previous && previous.expiresAt.getTime() > timestamp * 1000) {
    return `t=${timestamp},v1=${signWebhookBody(previous.secret, timestamp, body)},v2=${current}`
  }
  return `t=${timestamp},v1=${current}`
}

/**
 * Constant-time comparison of two hex signatures, for anything on this side
 * that needs to verify rather than produce one (tests, future inbound routes).
 */
export function webhookSignaturesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

// ---------------------------------------------------------------------------
// Outbound URL admission (SSRF guard)
// ---------------------------------------------------------------------------

/** Why an endpoint URL was refused. `null` on the success branch. */
export type WebhookUrlRejection =
  | 'invalid_url'
  | 'not_https'
  | 'no_host'
  | 'unresolvable'
  | 'private_address'

export type WebhookUrlAdmission =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; reason: WebhookUrlRejection; message: string }

/** Injected in tests so the guard's address table needs no live DNS. */
export type WebhookHostResolver = (hostname: string) => Promise<string[]>

const defaultResolver: WebhookHostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((r) => r.address)
}

/** The one HTTPS predicate. Mirrored by the zod `httpsUrl` refinement and by the form. */
export function isHttpsWebhookUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === 'https:'
  } catch {
    return false
  }
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  return octets
}

/**
 * RFC1918 / loopback / link-local / CGNAT / multicast / broadcast / "this
 * network". Anything not routable on the public internet is refused: the point
 * is that a customer-supplied URL must not reach anything the API host can
 * reach and the public cannot.
 */
function isPrivateIpv4(address: string): boolean {
  const octets = parseIpv4(address)
  if (!octets) return true // unparseable — fail closed
  const [a, b] = octets as [number, number, number, number]
  if (a === 0) return true // 0.0.0.0/8 "this network"
  if (a === 10) return true // RFC1918
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT RFC6598
  if (a === 192 && b === 0) return true // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking RFC2544
  if (a >= 224) return true // multicast, reserved, 255.255.255.255
  return false
}

/** Loopback `::1`, unspecified `::`, ULA `fc00::/7`, link-local `fe80::/10`, multicast `ff00::/8`. */
function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? ''

  // IPv4-mapped / IPv4-compatible: judge the embedded v4 address.
  const embedded = normalized.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (embedded?.[1]) return isPrivateIpv4(embedded[1])

  if (normalized === '::1' || normalized === '::') return true

  const head = normalized.split(':')[0] ?? ''
  if (head === '') return true // a leading `::` we did not match above — fail closed
  const leading = Number.parseInt(head.padStart(4, '0').slice(0, 4), 16)
  if (Number.isNaN(leading)) return true
  if ((leading & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((leading & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((leading & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/** True for any address a customer webhook must never be pointed at. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPrivateIpv4(address)
  if (family === 6) return isPrivateIpv6(address)
  return true // not an IP literal at all — fail closed
}

/**
 * URL admission for an outbound webhook POST: HTTPS only, and every resolved
 * address must be public.
 *
 * DNS is resolved here rather than left to the HTTP client because the check is
 * about *where the request lands*, not what the string looks like — a public
 * hostname with an `A` record of `127.0.0.1` is the whole attack. Every
 * returned address is checked, not just the first, since a resolver may hand
 * the client any of them.
 *
 * NOTE: this is a resolve-then-connect check, so a resolver that returns a
 * different answer on the client's own lookup (DNS rebinding) is not covered.
 * Closing that needs pinning the admitted address at connect time; the risk
 * accepted here is the same one the async worker carries.
 */
export async function admitWebhookUrl(
  raw: string,
  resolver: WebhookHostResolver = defaultResolver,
): Promise<WebhookUrlAdmission> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid_url', message: 'Endpoint URL is not a valid URL' }
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'not_https', message: 'Endpoint URL must be https://' }
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (!hostname) {
    return { ok: false, reason: 'no_host', message: 'Endpoint URL has no host' }
  }

  // An IP literal never reaches the resolver.
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) {
      return {
        ok: false,
        reason: 'private_address',
        message: 'Endpoint URL resolves to a private or loopback address',
      }
    }
    return { ok: true, url, addresses: [hostname] }
  }

  let addresses: string[]
  try {
    addresses = await resolver(hostname)
  } catch {
    return { ok: false, reason: 'unresolvable', message: `Could not resolve ${hostname}` }
  }

  if (addresses.length === 0) {
    return { ok: false, reason: 'unresolvable', message: `Could not resolve ${hostname}` }
  }

  if (addresses.some(isPrivateAddress)) {
    return {
      ok: false,
      reason: 'private_address',
      message: 'Endpoint URL resolves to a private or loopback address',
    }
  }

  return { ok: true, url, addresses }
}
