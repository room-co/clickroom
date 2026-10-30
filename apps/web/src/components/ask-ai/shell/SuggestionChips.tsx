import { getAllStarterPrompts } from '../starter-prompts'

interface SuggestionChipsProps {
  disabled: boolean
  onSelect: (prompt: string) => void
}

/** Compact horizontal chip strip shown above the composer once a
 * conversation already has messages (the empty state shows the full grouped
 * grid instead — see `AskAIEmptyState`). */
export function SuggestionChips({ disabled, onSelect }: SuggestionChipsProps) {
  const prompts = getAllStarterPrompts()
  return (
    <div className="mx-auto flex w-full max-w-3xl items-center gap-2 overflow-x-auto px-3 pb-1 sm:px-6">
      {prompts.map((p) => (
        <button
          key={p.label}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(p.prompt)}
          className="shrink-0 whitespace-nowrap rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-50"
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}
