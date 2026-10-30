import { Sparkles } from 'lucide-react'
import { STARTER_GROUPS } from '../starter-prompts'

interface AskAIEmptyStateProps {
  projectName?: string
  onSelect: (prompt: string) => void
}

/**
 * Empty-state for a fresh Ask AI conversation: a gradient AI mark + greeting
 * and a grid of clickable starter prompts grouped by domain (Analytics /
 * Flags / Experiments / SQL) PostHog-Max
 * inspired UX.
 */
export function AskAIEmptyState({ projectName, onSelect }: AskAIEmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-4 py-10 text-center">
      <div className="flex flex-col items-center gap-3">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/60">
          <Sparkles className="h-7 w-7 text-primary-foreground" />
        </span>
        <h2 className="text-lg font-semibold text-foreground">
          {projectName ? `Ask AI about ${projectName}` : 'Ask AI about your data'}
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Query analytics, manage flags and experiments, explore segments, or run SQL, grounded in
          this project's real data.
        </p>
      </div>
      <div className="grid w-full max-w-xl grid-cols-1 gap-4 sm:grid-cols-2">
        {STARTER_GROUPS.map((group) => (
          <div key={group.domain} className="text-left">
            <p className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {group.domain}
            </p>
            <div className="flex flex-col gap-1.5">
              {group.prompts.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="flex items-start gap-2 rounded-lg border border-border p-2.5 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted/40"
                  onClick={() => onSelect(p.prompt)}
                >
                  <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
