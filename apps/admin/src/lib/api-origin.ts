import { getApiOrigin } from './runtime-config'

/**
 * Runtime config note: the origin now comes from `window.__CLICKROOM_CONFIG__.apiOrigin`
 * (`/config.js`), with `VITE_API_ORIGIN` as a dev-only fallback. Empty = same-origin `/trpc`.
 */
/**
 * Where the tRPC HTTP link points.
 *
 * Mirrors apps/web/src/lib/api-origin.ts exactly (same env var, same reasoning) —
 * dev leaves `VITE_API_ORIGIN` unset and gets the relative `/trpc`, which
 * vite.config.ts proxies to the api on :3000 — same-origin, so the httpOnly
 * `clickroom_admin_rt` refresh cookie rides along for free.
 *
 * Prod builds set `VITE_API_ORIGIN=https://api.clickroom.co`, which makes every
 * tRPC call cross-ORIGIN (though still same-SITE). Callers must pass
 * `credentials: 'include'` for the refresh cookie to ride along cross-origin.
 *
 * Leaving this relative in a prod build resolves `/trpc` against the CloudFront
 * origin, which serves index.html for unknown paths — the client then dies
 * parsing HTML as JSON ("Unexpected token '<'").
 */
export const TRPC_URL = `${getApiOrigin()}/trpc`
