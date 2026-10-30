/**
 * Coerce a timestamp string to a Date. ClickHouse returns
 * `YYYY-MM-DD HH:mm:ss` (UTC, space separator, no `Z`); tRPC/ISO returns the
 * `T`/`Z` form. Both are normalized to UTC before parsing.
 */
function toDate(value: string): Date {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  return new Date(normalized)
}

/** Human-friendly absolute timestamp, or the raw value if unparseable. */
export function formatTimestamp(value: string): string {
  const d = toDate(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

/** Compact time-only label (e.g. for dense live feeds / hourly buckets). */
export function formatTime(value: string): string {
  const d = toDate(value)
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Short date label (e.g. daily trend buckets). */
export function formatDate(value: string): string {
  const d = toDate(value)
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Relative "just now / 12s ago / 5m ago / 3h ago" label. */
export function formatRelative(value: string): string {
  const d = toDate(value)
  if (Number.isNaN(d.getTime())) return value
  const seconds = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function formatNumber(value: number): string {
  return value.toLocaleString()
}
