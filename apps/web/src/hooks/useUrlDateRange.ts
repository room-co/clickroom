import { useCallback, useMemo } from 'react'
import type { DateRange as DayRange } from 'react-day-picker'
import { useSearchParams } from 'react-router'
import {
  type DateRange,
  type DateRangeSelection,
  type RangeKey,
  resolveDateRange,
} from '@/lib/range'

const DEFAULT_PRESETS: RangeKey[] = ['24h', '7d', '14d', '30d']
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** Serialize a picked date to `YYYY-MM-DD` — state already snaps to full days. */
function toDayParam(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Parse a `YYYY-MM-DD` (local) or ISO date param back into a Date, or undefined. */
function fromDayParam(raw: string | null): Date | undefined {
  if (!raw) return undefined
  if (DAY_ONLY.test(raw)) {
    const [y, m, d] = raw.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

export interface UseUrlDateRangeOptions {
  /** Query-param name for the preset/`custom` selection. Default `'range'`. */
  rangeParam?: string
  /** Query-param name for the custom-range start. Default `'from'`. */
  fromParam?: string
  /** Query-param name for the custom-range end. Default `'to'`. */
  toParam?: string
  /** The page's default selection — omitted from the URL when active. */
  defaultSelection?: DateRangeSelection
  /** Presets the page offers, used to validate `?range=`. */
  presetOptions?: RangeKey[]
  /**
   * Optional counter to force the resolved `range`'s "now" endpoint to advance
   * (e.g. an auto-refresh tick). Preset windows are computed relative to
   * `Date.now()` at call time, so without this a polling page re-fetches the
   * exact same frozen window.
   */
  refreshTick?: number
}

export interface UseUrlDateRange {
  selection: DateRangeSelection
  setSelection: (selection: DateRangeSelection) => void
  customRange: DayRange | undefined
  setCustomRange: (range: DayRange | undefined) => void
  range: DateRange
  interval: 'hour' | 'day'
}

/**
 * Date-range filter state backed by the URL query string instead of local
 * `useState`, so the selected range survives reload and travels in a shared
 * link. Drop-in for the hand-rolled `rangeSel`/`customRange` + `useMemo(
 * resolveDateRange)` trio: returns the same fields `DateRangeControl` consumes.
 *
 * Only the preset key is persisted (`?range=7d`) so presets keep rolling
 * forward against a live "now"; a custom pick additionally serializes its two
 * dates (`?range=custom&from=…&to=…`). The default selection is omitted so the
 * bare page URL stays param-free.
 */
export function useUrlDateRange(opts: UseUrlDateRangeOptions = {}): UseUrlDateRange {
  const {
    rangeParam = 'range',
    fromParam = 'from',
    toParam = 'to',
    defaultSelection = '7d',
    presetOptions = DEFAULT_PRESETS,
    refreshTick,
  } = opts

  const [searchParams, setSearchParams] = useSearchParams()

  const rawRange = searchParams.get(rangeParam)
  const rawFrom = searchParams.get(fromParam)
  const rawTo = searchParams.get(toParam)

  const validSelections = useMemo<readonly string[]>(
    () => [...presetOptions, 'custom'],
    [presetOptions],
  )
  const selection: DateRangeSelection =
    rawRange && validSelections.includes(rawRange)
      ? (rawRange as DateRangeSelection)
      : defaultSelection

  // Keyed on the raw strings so the Date objects stay referentially stable
  // across renders — otherwise the derived `range` (and thus the tRPC query
  // key) would change every render and refetch in a loop.
  const customRange = useMemo<DayRange | undefined>(() => {
    const from = fromDayParam(rawFrom)
    const to = fromDayParam(rawTo)
    if (!from && !to) return undefined
    return { from, to }
  }, [rawFrom, rawTo])

  // refreshTick is an intentional extra dep: it re-resolves the preset window's
  // "now" endpoint on each auto-refresh tick (the value itself is unused).
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTick forces "now" recompute
  const { range, interval } = useMemo(
    () => resolveDateRange(selection, customRange),
    [selection, customRange, refreshTick],
  )

  const setSelection = useCallback(
    (next: DateRangeSelection) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          if (next === defaultSelection) params.delete(rangeParam)
          else params.set(rangeParam, next)
          if (next !== 'custom') {
            params.delete(fromParam)
            params.delete(toParam)
          }
          return params
        },
        { replace: true },
      )
    },
    [setSearchParams, rangeParam, fromParam, toParam, defaultSelection],
  )

  const setCustomRange = useCallback(
    (next: DayRange | undefined) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          // Picking dates implies the custom selection.
          params.set(rangeParam, 'custom')
          if (next?.from) params.set(fromParam, toDayParam(next.from))
          else params.delete(fromParam)
          if (next?.to) params.set(toParam, toDayParam(next.to))
          else params.delete(toParam)
          return params
        },
        { replace: true },
      )
    },
    [setSearchParams, rangeParam, fromParam, toParam],
  )

  return { selection, setSelection, customRange, setCustomRange, range, interval }
}
