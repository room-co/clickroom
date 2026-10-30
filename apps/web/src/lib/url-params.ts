import type { SetURLSearchParams } from 'react-router'

/**
 * URL query-param helpers shared by pages that "sticky" their filters into the
 * address bar so a page is shareable/bookmarkable. All writes use `replace`
 * (not push) — a filter tweak is not new navigation history — and a param is
 * deleted when it equals the page default, so the bare URL stays canonical.
 */

/** Read an integer param, clamped to `min`; falls back to `fallback` on miss/NaN. */
export function parseIntParam(
  raw: string | null,
  fallback: number,
  opts?: { min?: number },
): number {
  if (raw == null) return fallback
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n)) return fallback
  return opts?.min != null ? Math.max(opts.min, n) : n
}

/** Read a string param, trimming; falls back to `fallback` when absent/empty. */
export function parseStringParam(raw: string | null, fallback = ''): string {
  const v = raw?.trim()
  return v ? v : fallback
}

/** Read a param constrained to a known set of allowed values, else `fallback`. */
export function parseEnumParam<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
}

/**
 * Build a single-param setter over `setSearchParams`. Writing `defaultValue`
 * (or null/empty) deletes the param instead of persisting a redundant value,
 * keeping shared links minimal.
 */
export function makeParamSetter(setSearchParams: SetURLSearchParams) {
  return (
    key: string,
    value: string | number | null | undefined,
    defaultValue?: string | number,
  ) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        if (value == null || value === '' || value === defaultValue) params.delete(key)
        else params.set(key, String(value))
        return params
      },
      { replace: true },
    )
  }
}
