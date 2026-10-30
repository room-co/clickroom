import { ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'
import { EventTypeBadge } from '@/components/badges'
import type { SegmentedOption } from '@/components/SegmentedToggle'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

interface EventTypePickerProps {
  /** First option is treated as the always-visible "all" pill. */
  options: ReadonlyArray<SegmentedOption<string>>
  value: string
  onChange: (value: string) => void
  visibleCount?: number
}

/**
 * Event-type filter: the "all" pill plus a handful of inline pills, with the
 * rest of the (dynamic, taxonomy-driven) list tucked behind a searchable
 * popover instead of a horizontal-scrolling pill row.
 */
export function EventTypePicker({
  options,
  value,
  onChange,
  visibleCount = 5,
}: EventTypePickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const { pinned, overflow } = useMemo(() => {
    const [all, ...rest] = options
    const inline = rest.slice(0, visibleCount)
    const hidden = rest.slice(visibleCount)

    const selectedInHidden = hidden.find((o) => o.value === value)
    if (selectedInHidden) {
      const bumped = inline.pop()
      inline.push(selectedInHidden)
      if (bumped) hidden.push(bumped)
    }

    return { pinned: all ? [all, ...inline] : inline, overflow: hidden }
  }, [options, value, visibleCount])

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center border border-border rounded overflow-hidden text-[11px] shrink-0">
        {pinned.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              'px-3 py-1.5 font-mono transition-colors whitespace-nowrap',
              value === option.value
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/40',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {overflow.length > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-border text-[11px] font-mono text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors shrink-0"
            >
              +{overflow.length}
              <ChevronDown className="w-3 h-3" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-0">
            <Command shouldFilter={false}>
              <CommandInput
                placeholder="Search event types..."
                value={search}
                onValueChange={setSearch}
              />
              <CommandList>
                <CommandEmpty>No matching event types.</CommandEmpty>
                <CommandGroup>
                  {overflow
                    .filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
                    .map((option) => (
                      <CommandItem
                        key={option.value}
                        value={option.value}
                        onSelect={() => {
                          onChange(option.value)
                          setOpen(false)
                          setSearch('')
                        }}
                      >
                        <EventTypeBadge type={option.value} />
                      </CommandItem>
                    ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
