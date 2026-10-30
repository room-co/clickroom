// @clickroom/sdk-js — UTM campaign parameter parsing.
// PURE, zero-dependency: this package bundles to a CDN script, so no imports.
// Parses `utm_*` query params off a URL's search string into PostHog-style
// `$utm_*` properties. Only emits keys actually present in the query string —
// never an empty string or a key for an absent param.

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'] as const

/**
 * Parse `utm_source`/`utm_medium`/`utm_campaign`/`utm_term`/`utm_content` off
 * a `location.search`-style string into `$utm_*` properties.
 */
export function parseUtm(search: string): Record<string, string> {
  const props: Record<string, string> = {}
  if (!search) return props

  try {
    const params = new URLSearchParams(search)
    for (const key of UTM_KEYS) {
      const value = params.get(`utm_${key}`)
      if (value) props[`$utm_${key}`] = value
    }
  } catch {
    // Malformed query string — return whatever was parsed before the throw.
  }

  return props
}
