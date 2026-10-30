/**
 * Formatting helpers, ported from apps/web/src/lib/format.ts's shape (same convention, this
 * app's own copy since apps/admin has no dependency on apps/web). Admin procedures return
 * `Date` objects (tRPC has no superjson transformer here — see the admin routers' own doc
 * comments) rather than ClickHouse's `YYYY-MM-DD HH:mm:ss` strings, so these accept
 * `Date | string` and coerce either.
 */

function toDate(value: Date | string): Date {
  if (value instanceof Date) return value
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  return new Date(normalized)
}

/** Human-friendly absolute timestamp, or the raw value if unparseable. */
export function formatTimestamp(value: Date | string): string {
  const d = toDate(value)
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString()
}

/** Short date label (e.g. daily trend buckets). */
export function formatDate(value: Date | string): string {
  const d = toDate(value)
  return Number.isNaN(d.getTime())
    ? String(value)
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Relative "just now / 12s ago / 5m ago / 3h ago" label. */
export function formatRelative(value: Date | string): string {
  const d = toDate(value)
  if (Number.isNaN(d.getTime())) return String(value)
  const seconds = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Countdown "mm:ss" label for a future instant; clamps at "00:00" once past. */
export function formatCountdown(target: Date | string): string {
  const d = toDate(target)
  const totalSeconds = Math.max(0, Math.floor((d.getTime() - Date.now()) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function formatNumber(value: number): string {
  return value.toLocaleString()
}

export function formatPercent(value: number): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
}
