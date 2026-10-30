import { useNavigate } from 'react-router'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { NAV_GROUPS } from './nav-groups'

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * ⌘K / Ctrl+K command palette. Deliberately simple — a searchable
 * list of the nav items in `nav-groups.ts` for fast navigation between the
 * pages that exist. Not a full fuzzy-search-everything palette (that's
 * explicitly out of scope for this task); cmdk's built-in `shouldFilter`
 * default handles the search.
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate()

  function handleSelect(path: string) {
    navigate(path)
    onOpenChange(false)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Jump to a page in the admin console."
    >
      <CommandInput placeholder="Jump to a page…" />
      <CommandList>
        <CommandEmpty>No matching page.</CommandEmpty>
        {NAV_GROUPS.map((group) => (
          <CommandGroup key={group.label} heading={group.label}>
            {group.items.map((item) => (
              <CommandItem
                key={item.path}
                value={`${group.label} ${item.label}`}
                onSelect={() => handleSelect(item.path)}
              >
                <item.icon />
                <span>{item.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
