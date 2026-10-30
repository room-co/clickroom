import { RANGE_OPTIONS, type RangeKey } from '@/lib/range'
import { cn } from '@/lib/utils'

const DEFAULT_OPTIONS: RangeKey[] = ['24h', '7d', '14d', '30d']

/** Segmented-pill date-range control matching the dashboard's inline pills. */
export function RangeFilter({
  value,
  onChange,
  options = DEFAULT_OPTIONS,
}: {
  value: RangeKey
  onChange: (value: RangeKey) => void
  options?: RangeKey[]
}) {
  const pills = RANGE_OPTIONS.filter((opt) => options.includes(opt.key))
  return (
    <div className="flex items-center gap-px bg-muted/30 border border-border rounded-lg p-0.5">
      {pills.map(({ key, shortLabel }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={cn(
            'px-3 py-1.5 rounded-md text-[11px] font-mono font-medium transition-all',
            value === key
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
