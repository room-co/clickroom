// @clickroom/sdk-js — traffic channel classification.
// PURE, zero-dependency: this package bundles to a CDN script, so no imports.
// Classifies `document.referrer` + the session's UTM params into a
// PostHog-style `$channel_type`, using small static domain lists — no
// external lookup/API call, synchronous, same style as device.ts's UA parser.

// utm_medium values that indicate paid traffic.
const PAID_MEDIUM_RE = /^(cpc|ppc|paid|display)$/i

// Referring-domain substrings for well-known search engines. Matched with a
// simple `includes` so subdomains/ccTLDs (e.g. `www.google.co.uk`) still hit.
const SEARCH_ENGINE_DOMAINS = [
  'google.',
  'bing.com',
  'duckduckgo.com',
  'yahoo.',
  'baidu.com',
  'yandex.',
  'ecosia.org',
  'ask.com',
  'aol.com',
]

// Referring-domain substrings for well-known social platforms.
const SOCIAL_DOMAINS = [
  'facebook.com',
  'fb.com',
  'twitter.com',
  'x.com',
  't.co',
  'linkedin.com',
  'instagram.com',
  'tiktok.com',
  'reddit.com',
  'pinterest.',
  'youtube.com',
  'threads.net',
]

const matchesDomain = (domain: string, list: string[]): boolean =>
  list.some((needle) => domain.includes(needle))

const extractDomain = (url: string): string | undefined => {
  if (!url) return undefined
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * Classify a visit into a `$channel_type` bucket from its referrer + UTM
 * params. Rule order (first match wins): direct, paid, organic search,
 * social, email, referral, fallback direct.
 *
 * @param referrer `document.referrer`.
 * @param utm The `$utm_*` properties already parsed by `parseUtm`.
 * @param currentHostname The current page's hostname (`location.hostname`),
 *   used to avoid classifying same-site referrers as `referral`.
 */
export function classifyChannel(
  referrer: string,
  utm: Record<string, string>,
  currentHostname: string,
): string {
  const referrerDomain = extractDomain(referrer)
  const utmMedium = utm.$utm_medium
  const hasReferrer = Boolean(referrerDomain)
  const hasUtm = Object.keys(utm).length > 0

  if (!hasReferrer && !hasUtm) return 'direct'
  if (utmMedium && PAID_MEDIUM_RE.test(utmMedium)) return 'paid'
  if (referrerDomain && matchesDomain(referrerDomain, SEARCH_ENGINE_DOMAINS))
    return 'organic search'
  if (referrerDomain && matchesDomain(referrerDomain, SOCIAL_DOMAINS)) return 'social'
  if (utmMedium && utmMedium.toLowerCase() === 'email') return 'email'
  if (referrerDomain && referrerDomain !== currentHostname.toLowerCase()) return 'referral'
  return 'direct'
}
