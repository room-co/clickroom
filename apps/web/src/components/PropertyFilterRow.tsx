import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { resolveDateRange } from '@/lib/range'
import { trpc } from '@/lib/trpc'

// Event-property filters use a scoped subset of the flags operator vocabulary
// (/ funnelStepFilterSchema in events.router.ts). Shared by the
// funnel step builder, and the trend/breakdown insight builders.
export const FILTER_OPERATORS = ['exact', 'is_not', 'icontains', 'gt', 'lt', 'is_set'] as const
export type FilterOperator = (typeof FILTER_OPERATORS)[number]
export const VALUELESS_OPERATORS: ReadonlySet<FilterOperator> = new Set<FilterOperator>(['is_set'])
export const FILTER_OPERATOR_LABELS: Record<FilterOperator, string> = {
  exact: 'equals',
  is_not: 'is not',
  icontains: 'contains',
  gt: 'greater than',
  lt: 'less than',
  is_set: 'is set',
}

export interface PropertyFilter {
  key: string
  operator: FilterOperator
  value: unknown
}

// Default 30-day range for the property-value autocomplete query — filter rows
// have no date-range control of their own, this just bounds the ClickHouse scan.
export const FILTER_AUTOCOMPLETE_RANGE = resolveDateRange('30d').range

export function emptyPropertyFilter(): PropertyFilter {
  return { key: '', operator: 'exact', value: '' }
}

/** A single "IF/AND <property> <operator> <value>" condition row with a
 * property-name Select (falls back to free text when no taxonomy options are
 * known yet) and a value input backed by a debounced property-values
 * autocomplete datalist. Shared by FunnelBuilderPage's step filters and
 * InsightBuilderPage's trend/breakdown/funnel-step filters. */
export function PropertyFilterRow({
  index,
  filter,
  projectId,
  event,
  propertyOptions,
  onChange,
  onRemove,
  datalistIdPrefix = 'property-filter-values',
}: {
  index: number
  filter: PropertyFilter
  projectId: string
  event: string
  propertyOptions: { value: string; label: string }[]
  onChange: (patch: Partial<PropertyFilter>) => void
  onRemove: () => void
  datalistIdPrefix?: string
}) {
  const valueless = VALUELESS_OPERATORS.has(filter.operator)
  const [debouncedKey, setDebouncedKey] = useState(filter.key)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedKey(filter.key), 300)
    return () => clearTimeout(t)
  }, [filter.key])

  const propertyValues = trpc.events.propertyValues.useQuery(
    { projectId, event, key: debouncedKey, range: FILTER_AUTOCOMPLETE_RANGE },
    { enabled: !!projectId && !!event && !!debouncedKey && !valueless },
  )
  const datalistId = `${datalistIdPrefix}-${event}-${index}`

  return (
    <div className="flex items-center gap-2">
      <span className="w-7 shrink-0 font-mono text-[10px] font-medium text-amber-400">
        {index === 0 ? 'IF' : 'AND'}
      </span>
      <div className="flex flex-1 flex-wrap items-center gap-2">
        {propertyOptions.length > 0 ? (
          <Select value={filter.key || undefined} onValueChange={(v) => onChange({ key: v })}>
            <SelectTrigger className="h-7 w-32 text-[11px]">
              <SelectValue placeholder="property" />
            </SelectTrigger>
            <SelectContent>
              {propertyOptions.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <input
            value={filter.key}
            onChange={(e) => onChange({ key: e.target.value })}
            placeholder="property"
            className="w-32 rounded bg-muted/50 px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        )}
        <Select
          value={filter.operator}
          onValueChange={(v) => onChange({ operator: v as FilterOperator })}
        >
          <SelectTrigger className="h-7 w-[130px] text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTER_OPERATORS.map((op) => (
              <SelectItem key={op} value={op} className="text-xs">
                {FILTER_OPERATOR_LABELS[op]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!valueless && (
          <>
            <input
              value={String(filter.value ?? '')}
              onChange={(e) => onChange({ value: e.target.value })}
              placeholder="value"
              list={datalistId}
              className="w-32 rounded bg-primary/10 px-2 py-1 font-mono text-xs text-primary placeholder:text-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            <datalist id={datalistId}>
              {(propertyValues.data ?? []).map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="ml-2 shrink-0 text-muted-foreground/40 transition-colors hover:text-red-400"
        aria-label="Remove condition"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
