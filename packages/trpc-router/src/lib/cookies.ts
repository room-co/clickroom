import {
  ADMIN_REFRESH_TOKEN_COOKIE,
  ADMIN_REFRESH_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_TTL_SECONDS,
} from '@clickroom/auth'
import type { CookieOptions, Response } from 'express'

// `lax`, not `strict`: `strict` withholds the cookie on top-level navigations that
// originate from another site, which breaks the SSO callback (the IdP redirects
// back with a GET) and any future entry point outside the app origin. The SSO relay
// cookie already had to reach for `lax` for exactly this reason.
//
// `domain` comes ONLY from `COOKIE_DOMAIN`: unset (the default, and right for single-domain
// installs) means a host-only cookie; set it (e.g. `.example.com`) to share the cookie across
// app./api. subdomains.
//
// `secure` follows the scheme of `WEB_PUBLIC_URL` (https => Secure) so a plain-HTTP
// `http://localhost` self-host install can sign in; with no `WEB_PUBLIC_URL` it falls back to
// `NODE_ENV === 'production'`.
function cookieSecure(): boolean {
  const publicUrl = process.env.WEB_PUBLIC_URL?.trim()
  if (publicUrl) return publicUrl.toLowerCase().startsWith('https://')
  return process.env.NODE_ENV === 'production'
}

function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    domain: process.env.COOKIE_DOMAIN || undefined,
    path: '/',
  }
}

/**
 * Evict the legacy *host-only* refresh cookie — the one this app set on
 * `the API host before `COOKIE_DOMAIN` existed.
 *
 * A cookie's identity is (name, domain, path). Adding `domain=.example.com`
 * therefore did not overwrite the old host-only cookie of the same name: it
 * created a second one. The browser then sends BOTH on every request to
 * the API host, Express keeps one, and if it keeps the stale twin,
 * `auth.refresh` looks up a selector with no live `Session` and 401s — the user
 * is bounced to /login on every cold load, and SSO appears to "not work" even
 * though the callback minted a perfectly good session. Logout could not rescue
 * them either: `clearCookie` only matches a cookie whose domain it was given, so
 * the domain-scoped clear silently left the host-only twin in place.
 *
 * Sending this delete alongside every set/clear evicts the twin on the user's
 * next request. No-op for anyone who never had it, and a no-op in dev (where the
 * live cookie IS host-only — deleting it there would log everyone out, hence the
 * `COOKIE_DOMAIN` guard).
 */
export function clearLegacyHostOnlyCookie(res: Response): void {
  if (!process.env.COOKIE_DOMAIN) return
  res.clearCookie(REFRESH_TOKEN_COOKIE, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    path: '/',
    // No `domain` — that is the whole point: this targets the host-only cookie.
  })
}

/** Set the httpOnly refresh-token cookie (rotated on every refresh). */
export function setRefreshCookie(res: Response, token: string): void {
  clearLegacyHostOnlyCookie(res)
  res.cookie(REFRESH_TOKEN_COOKIE, token, {
    ...refreshCookieOptions(),
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
  })
}

/**
 * Clear the refresh-token cookie on logout. Must pass the SAME attributes the
 * cookie was set with — a `clearCookie` whose domain/path don't match silently
 * fails to clear, leaving the user logged in.
 */
export function clearRefreshCookie(res: Response): void {
  clearLegacyHostOnlyCookie(res)
  res.clearCookie(REFRESH_TOKEN_COOKIE, refreshCookieOptions())
}

/**
 * Set the httpOnly admin refresh-token cookie. Uses the same
 * `refreshCookieOptions()` shape as the tenant cookie (lax/httpOnly/secure,
 * `COOKIE_DOMAIN`-scoped when set) but its own name (`clickroom_admin_rt`) and
 * TTL — a wholly separate identity plane, so its cookie must
 * never collide with (or be clearable by) the tenant session cookie logic.
 */
export function setAdminRefreshCookie(res: Response, token: string): void {
  res.cookie(ADMIN_REFRESH_TOKEN_COOKIE, token, {
    ...refreshCookieOptions(),
    maxAge: ADMIN_REFRESH_TOKEN_TTL_SECONDS * 1000,
  })
}

/** Clear the admin refresh-token cookie on admin logout. */
export function clearAdminRefreshCookie(res: Response): void {
  res.clearCookie(ADMIN_REFRESH_TOKEN_COOKIE, refreshCookieOptions())
}
