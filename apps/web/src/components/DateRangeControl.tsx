import { format, subDays } from 'date-fns'
import { Check, ChevronDown, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import type { DateRange as DayRange } from 'react-day-picker'
import { Calendar } from '@/components/ui/calendar'
import {
  type DateRangeSelection,
  RANGE_OPTIONS,
  type RangeKey,
  type UsersWindow,
  windowRangeOptions,
} from '@/lib/range'
import { cn } from '@/lib/utils'

const DEFAULT_PRESETS: RangeKey[] = ['24h', '7d', '14d', '30d']

const REFRESH_OPTIONS: ReadonlyArray<{ label: string; value: number }> = [
  { label: 'Off', value: 0 },
  { label: '5s', value: 5000 },
  { label: '10s', value: 10000 },
  { label: '30s', value: 30000 },
  { label: '1m', value: 60000 },
]

interface DateRangeControlProps {
  selection: DateRangeSelection
  onSelectionChange: (selection: DateRangeSelection) => void
  customRange?: DayRange
  onCustomRangeChange?: (range: DayRange | undefined) => void
  /** Omit to hide the auto-refresh dropdown entirely. */
  refresh?: { value: number; onChange: (ms: number) => void }
  presetOptions?: RangeKey[]
}

/**
 * Shared date-range control: preset pills + a "Custom" pill opening a range
 * calendar, with an optional auto-refresh dropdown for live-updating pages.
 * Reuse this everywhere date filtering appears — don't hand-roll another one.
 */
export function DateRangeControl({
  selection,
  onSelectionChange,
  customRange,
  onCustomRangeChange,
  refresh,
  presetOptions = DEFAULT_PRESETS,
}: DateRangeControlProps) {
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [refreshOpen, setRefreshOpen] = useState(false)

  const presets = RANGE_OPTIONS.filter((opt) => presetOptions.includes(opt.key))
  const customLabel = customRange?.from
    ? customRange.to
      ? `${format(customRange.from, 'MMM d')} – ${format(customRange.to, 'MMM d')}`
      : format(customRange.from, 'MMM d')
    : 'Pick dates'

  const isLive = !!refresh && refresh.value > 0
  const refreshLabel = REFRESH_OPTIONS.find((o) => o.value === refresh?.value)?.label ?? 'Off'

  return (
    <div className="flex flex-wrap items-center gap-2 sm:gap-3">
      <div className="flex items-center gap-px bg-muted/30 border border-border rounded-lg p-0.5">
        {presets.map(({ key, shortLabel }) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              onSelectionChange(key)
              setCalendarOpen(false)
            }}
            className={cn(
              'px-3 py-1.5 rounded-md text-[11px] font-mono font-medium transition-all',
              selection === key
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {shortLabel}
          </button>
        ))}

        {onCustomRangeChange && (
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                onSelectionChange('custom')
                setCalendarOpen((o) => !o)
              }}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-all whitespace-nowrap',
                selection === 'custom'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {selection === 'custom' ? customLabel : 'Custom'}
              <ChevronDown
                className={cn(
                  'w-3 h-3 transition-transform shrink-0',
                  calendarOpen && 'rotate-180',
                )}
              />
            </button>

            {calendarOpen && (
              <>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: click-away backdrop */}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-away backdrop */}
                <div className="fixed inset-0 z-10" onClick={() => setCalendarOpen(false)} />
                <div className="absolute right-0 top-full mt-2 z-20 bg-popover border border-border rounded-xl shadow-2xl shadow-black/50 overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                    <span className="text-xs font-medium text-foreground">Custom range</span>
                    <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
                      <span
                        className={cn(
                          'px-2 py-0.5 rounded bg-muted/50',
                          customRange?.from && 'text-foreground',
                        )}
                      >
                        {customRange?.from ? format(customRange.from, 'MMM d, yyyy') : 'Start date'}
                      </span>
                      <span>→</span>
                      <span
                        className={cn(
                          'px-2 py-0.5 rounded bg-muted/50',
                          customRange?.to && 'text-foreground',
                        )}
                      >
                        {customRange?.to ? format(customRange.to, 'MMM d, yyyy') : 'End date'}
                      </span>
                    </div>
                  </div>

                  <Calendar
                    mode="range"
                    numberOfMonths={2}
                    selected={customRange}
                    onSelect={onCustomRangeChange}
                    defaultMonth={subDays(new Date(), 30)}
                    disabled={{ after: new Date() }}
                    className="p-4"
                  />

                  <div className="flex items-center gap-2 px-4 py-3 border-t border-border bg-muted/10">
                    <span className="text-[10px] text-muted-foreground mr-1">Quick:</span>
                    {[
                      { label: 'Last 7 days', from: subDays(new Date(), 6), to: new Date() },
                      { label: 'Last 14 days', from: subDays(new Date(), 13), to: new Date() },
                      { label: 'Last 30 days', from: subDays(new Date(), 29), to: new Date() },
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => onCustomRangeChange({ from: preset.from, to: preset.to })}
                        className="text-[10px] px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:border-border/80 transition-colors"
                      >
                        {preset.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setCalendarOpen(false)}
                      disabled={!customRange?.from || !customRange?.to}
                      className="ml-auto text-[11px] px-3 py-1.5 bg-primary text-primary-foreground rounded-md font-medium hover:opacity-90 transition-opacity disabled:opacity-40"
                    >
                      Apply
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {refresh && (
        <>
          <div className="w-px h-5 bg-border" />
          <div className="relative">
            <button
              type="button"
              onClick={() => setRefreshOpen((o) => !o)}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs transition-colors',
                isLive
                  ? 'border-primary/30 bg-primary/5 text-primary'
                  : 'border-border bg-muted/20 text-muted-foreground hover:text-foreground hover:border-border/80',
              )}
            >
              {isLive ? (
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse shrink-0" />
              ) : (
                <RefreshCw className="w-3 h-3 shrink-0" />
              )}
              <span className="font-mono">{isLive ? `Every ${refreshLabel}` : 'Refresh'}</span>
              <ChevronDown
                className={cn('w-3 h-3 shrink-0 transition-transform', refreshOpen && 'rotate-180')}
              />
            </button>

            {refreshOpen && (
              <>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: click-away backdrop */}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-away backdrop */}
                <div className="fixed inset-0 z-10" onClick={() => setRefreshOpen(false)} />
                <div className="absolute right-0 top-full mt-1.5 z-20 w-44 bg-popover border border-border rounded-lg shadow-xl shadow-black/40 overflow-hidden">
                  <div className="px-3 py-2 border-b border-border">
                    <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                      Auto-refresh
                    </div>
                  </div>
                  {REFRESH_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => {
                        refresh.onChange(opt.value)
                        setRefreshOpen(false)
                      }}
                      className={cn(
                        'w-full flex items-center justify-between px-3 py-2 text-xs transition-colors text-left',
                        refresh.value === opt.value
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted/30',
                      )}
                    >
                      <span>{opt.label}</span>
                      {refresh.value === opt.value && <Check className="w-3 h-3" />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

interface WindowRangeControlProps {
  window: UsersWindow
  selection: string
  onSelectionChange: (key: string) => void
}

/**
 * Preset-pill control scoped to a `users` (DAU/WAU/MAU) insight's bucket
 * window — deliberately simpler than `DateRangeControl` (no custom-range
 * calendar): a sub-window range isn't meaningful for a windowed series, so
 * only the window's own preset ladder (`windowRangeOptions`) is offered.
 */
export function WindowRangeControl({
  window,
  selection,
  onSelectionChange,
}: WindowRangeControlProps) {
  const options = windowRangeOptions(window)
  return (
    <div className="flex items-center gap-px bg-muted/30 border border-border rounded-lg p-0.5 w-fit">
      {options.map(({ key, shortLabel }) => (
        <button
          key={key}
          type="button"
          onClick={() => onSelectionChange(key)}
          className={cn(
            'px-3 py-1.5 rounded-md text-[11px] font-mono font-medium transition-all',
            selection === key
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {shortLabel}
        </button>
      ))}
    </div>
  )
}
