import { cn } from '@/lib/utils'

/**
 * The four-tone health indicator — a coloured dot with an
 * optional label chip.
 *
 * Deliberately separate from `badges.tsx`'s `StatusBadge`, which is the
 * user-lifecycle badge (active / churned / new) and must not be widened into a
 * generic. The tones here map to the webhook health rollup:
 * healthy · degraded · failing · idle.
 */
export type HealthTone = 'healthy' | 'degraded' | 'failing' | 'idle'

const toneStyles: Record<HealthTone, { dot: string; chip: string }> = {
  healthy: { dot: 'bg-teal-400', chip: 'bg-teal-500/15 text-teal-400 border-teal-500/25' },
  degraded: { dot: 'bg-amber-400', chip: 'bg-amber-500/15 text-amber-400 border-amber-500/25' },
  failing: { dot: 'bg-red-400', chip: 'bg-red-500/15 text-red-400 border-red-500/25' },
  idle: {
    dot: 'bg-muted-foreground/40',
    chip: 'bg-muted text-muted-foreground border-border',
  },
}

const toneLabels: Record<HealthTone, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  failing: 'Failing',
  idle: 'Idle',
}

export function StatusDot({
  tone,
  label,
  showLabel = true,
  className,
}: {
  tone: HealthTone
  /** Overrides the default tone label ("Healthy", "Degraded", …). */
  label?: string
  /** `false` renders the bare dot — for dense rows where a chip is too heavy. */
  showLabel?: boolean
  className?: string
}) {
  const styles = toneStyles[tone]
  const text = label ?? toneLabels[tone]

  if (!showLabel) {
    return (
      <span
        role="img"
        aria-label={text}
        title={text}
        className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', styles.dot, className)}
      />
    )
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium',
        styles.chip,
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', styles.dot)} />
      {text}
    </span>
  )
}
