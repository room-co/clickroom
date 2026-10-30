import { Pencil, Trash2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface Conversation {
  id: string
  title: string | null
}

export interface RenameControls {
  renamingId: string | null
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
  onStart: (id: string, current: string | null) => void
}

interface ThreadListItemProps {
  conv: Conversation
  selected: boolean
  rename: RenameControls
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}

export function ThreadListItem({
  conv,
  selected,
  rename,
  onSelect,
  onDelete,
}: ThreadListItemProps) {
  if (rename.renamingId === conv.id) {
    return (
      <Input
        autoFocus
        value={rename.value}
        onChange={(e) => rename.onChange(e.target.value)}
        onBlur={rename.onSubmit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') rename.onSubmit()
          if (e.key === 'Escape') rename.onCancel()
        }}
        className="h-8 text-xs"
      />
    )
  }
  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded-md px-2 py-2 transition-colors',
        selected
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted/30 hover:text-foreground',
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(conv.id)}
        className="flex-1 truncate text-left text-xs font-medium"
      >
        {conv.title?.trim() || 'New conversation'}
      </button>
      <button
        type="button"
        onClick={() => rename.onStart(conv.id, conv.title)}
        className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
        aria-label="Rename conversation"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => onDelete(conv.id)}
        className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
        aria-label="Delete conversation"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
