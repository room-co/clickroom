export type RangeKey = '24h' | '7d' | '14d' | '30d'

export interface DateRange {
  from: string
  to: string
}

export const RANGE_OPTIONS: { key: RangeKey; label: string; shortLabel: string }[] = [
  { key: '24h', label: 'Last 24 hours', shortLabel: '24h' },
  { key: '7d', label: 'Last 7 days', shortLabel: '7d' },
  { key: '14d', label: 'Last 14 days', shortLabel: '14d' },
  { key: '30d', label: 'Last 30 days', shortLabel: '30d' },
]

const DAY_MS = 864e5

const SPANS: Record<RangeKey, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '14d': 14 * DAY_MS,
  '30d': 30 * DAY_MS,
}

/** Build an ISO-8601 `{ from, to }` window for the given range key. */
export function rangeFromKey(key: RangeKey): DateRange {
  const now = Date.now()
  return {
    from: new Date(now - SPANS[key]).toISOString(),
    to: new Date(now).toISOString(),
  }
}

/** Bucket granularity that best fits the range: hourly for 24h, daily beyond. */
export function intervalForKey(key: RangeKey): 'hour' | 'day' {
  return key === '24h' ? 'hour' : 'day'
}

/**
 * Build an ISO `{ from, to }` window from two picked dates, snapped to the full
 * days they fall on (start-of-`from`-day → end-of-`to`-day) so a single-day pick
 * still spans a usable window.
 */
export function rangeFromDates(from: Date, to: Date): DateRange {
  const start = new Date(from)
  start.setHours(0, 0, 0, 0)
  const end = new Date(to)
  end.setHours(23, 59, 59, 999)
  return { from: start.toISOString(), to: end.toISOString() }
}

/** Hourly buckets for spans up to ~2 days, daily beyond. */
export function intervalForSpan(from: Date, to: Date): 'hour' | 'day' {
  return to.getTime() - from.getTime() <= 2 * DAY_MS ? 'hour' : 'day'
}

export type DateRangeSelection = RangeKey | 'custom'

/**
 * Resolve a preset-or-custom selection into a query-ready `{ range, interval }` pair.
 * Falls back to `7d` if `custom` is selected without a complete `{ from, to }` pick yet.
 */
export function resolveDateRange(
  selection: DateRangeSelection,
  customRange?: { from?: Date; to?: Date },
): { range: DateRange; interval: 'hour' | 'day' } {
  const customActive = selection === 'custom' && !!customRange?.from && !!customRange?.to
  if (customActive && customRange?.from && customRange?.to) {
    return {
      range: rangeFromDates(customRange.from, customRange.to),
      interval: intervalForSpan(customRange.from, customRange.to),
    }
  }
  const key = (selection === 'custom' ? '7d' : selection) as RangeKey
  return { range: rangeFromKey(key), interval: intervalForKey(key) }
}

// ── Window-scoped presets for `users` (DAU/WAU/MAU) insights ────────────────
// The generic 24h/7d/14d/30d ladder isn't meaningful for a windowed
// day/week/month active-users series (e.g. a 2-day window on an MAU chart
// would only ever render 0-1 bucket) — kept as a parallel, deliberately
// small preset set instead of widening `RangeKey`, so the generic
// resolveDateRange/DateRangeControl flow used everywhere else is untouched.
export type UsersWindow = 'day' | 'week' | 'month'

export interface WindowRangeOption {
  key: string
  label: string
  shortLabel: string
}

const WINDOW_PRESETS: Record<UsersWindow, (WindowRangeOption & { days: number })[]> = {
  day: [
    { key: '30d', label: 'Last 30 days', shortLabel: '30d', days: 30 },
    { key: '90d', label: 'Last 90 days', shortLabel: '90d', days: 90 },
  ],
  week: [
    { key: '12w', label: 'Last 12 weeks', shortLabel: '12w', days: 12 * 7 },
    { key: '26w', label: 'Last 26 weeks', shortLabel: '26w', days: 26 * 7 },
  ],
  month: [
    { key: '6mo', label: 'Last 6 months', shortLabel: '6mo', days: 6 * 30 },
    { key: '12mo', label: 'Last 12 months', shortLabel: '12mo', days: 12 * 30 },
  ],
}

/** Preset options scoped to a `users` insight's bucket window (day/week/month). */
export function windowRangeOptions(window: UsersWindow): WindowRangeOption[] {
  return WINDOW_PRESETS[window].map(({ key, label, shortLabel }) => ({ key, label, shortLabel }))
}

/** First (shortest) preset key for a given window — used as the default selection. */
export function defaultWindowRangeSelection(window: UsersWindow): string {
  return WINDOW_PRESETS[window][0].key
}

/** Resolve a window-scoped preset key into an absolute `{ from, to }` window. */
export function resolveWindowRange(window: UsersWindow, selection: string): DateRange {
  const opts = WINDOW_PRESETS[window]
  const opt = opts.find((o) => o.key === selection) ?? opts[0]
  const now = Date.now()
  return { from: new Date(now - opt.days * DAY_MS).toISOString(), to: new Date(now).toISOString() }
}
