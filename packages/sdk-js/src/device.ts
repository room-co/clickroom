// @clickroom/sdk-js — lightweight user-agent parsing (device/OS/browser).
// PURE, zero-dependency: this package bundles to a CDN script, so no imports.
// Emits PostHog-style `$` property keys. Only returns keys it can determine.

// ---- browser detection --------------------------------------------------
// Order matters: Edg/OPR/SamsungBrowser must be checked before Chrome, and
// Chrome before Safari (Chrome UAs also contain a "Safari" token).

interface BrowserMatch {
  name: string
  // Regex whose first capture group is the major version (when present).
  re: RegExp
}

const BROWSERS: BrowserMatch[] = [
  { name: 'Edge', re: /Edg(?:e|A|iOS)?\/(\d+)/ },
  { name: 'Opera', re: /(?:OPR|Opera)\/(\d+)/ },
  { name: 'Samsung Internet', re: /SamsungBrowser\/(\d+)/ },
  { name: 'Firefox', re: /(?:Firefox|FxiOS)\/(\d+)/ },
  { name: 'Chrome', re: /(?:Chrome|CriOS)\/(\d+)/ },
  { name: 'Safari', re: /Version\/(\d+).*Safari/ },
]

const detectBrowser = (ua: string): { name?: string; version?: string } => {
  for (const b of BROWSERS) {
    const m = ua.match(b.re)
    if (m) return { name: b.name, version: m[1] }
  }
  return {}
}

// ---- OS detection -------------------------------------------------------

const detectOS = (ua: string): string | undefined => {
  if (/Windows/.test(ua)) return 'Windows'
  // iOS must precede macOS (iPad/iPhone UAs may mention "Mac OS X").
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS'
  if (/Android/.test(ua)) return 'Android'
  if (/CrOS/.test(ua)) return 'Chrome OS'
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS'
  if (/Linux/.test(ua)) return 'Linux'
  return undefined
}

// ---- device type --------------------------------------------------------
// iPad -> Tablet; a "Mobile" token -> Mobile; Android without "Mobile" -> Tablet.

const detectDeviceType = (ua: string): string => {
  if (/iPad/.test(ua)) return 'Tablet'
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Mobile' : 'Tablet'
  if (/iPhone|iPod/.test(ua)) return 'Mobile'
  if (/Mobile/.test(ua)) return 'Mobile'
  return 'Desktop'
}

/**
 * Parse a user-agent + language into PostHog-style device properties.
 * Returns only the keys it can determine (never undefined values).
 */
export function parseDevice(
  userAgent: string,
  language: string | undefined,
): Record<string, string> {
  const props: Record<string, string> = {}

  const ua = userAgent ?? ''
  if (ua) {
    const browser = detectBrowser(ua)
    if (browser.name) props.$browser = browser.name
    if (browser.version) props.$browser_version = browser.version

    const os = detectOS(ua)
    if (os) props.$os = os

    props.$device_type = detectDeviceType(ua)
  }

  if (language) props.$lang = language

  return props
}
