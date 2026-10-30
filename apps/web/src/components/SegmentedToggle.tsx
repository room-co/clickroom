import { cn } from '@/lib/utils'

export type SegmentedOption<T> = {
  label: string
  value: T
}

export function SegmentedToggle<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="flex items-center border border-border rounded overflow-hidden text-[11px]">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'px-3 py-1.5 font-mono transition-colors',
            value === option.value
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/40',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
