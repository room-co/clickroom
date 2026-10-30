import { cn } from '@/lib/utils'

// Semantic colors for known system ($) events + the make-reference categories.
const eventTypeStyles: Record<string, string> = {
  $pageview: 'bg-violet-500/15 text-violet-400 border-violet-500/25',
  pageview: 'bg-violet-500/15 text-violet-400 border-violet-500/25',
  $autocapture: 'bg-teal-500/15 text-teal-400 border-teal-500/25',
  click: 'bg-teal-500/15 text-teal-400 border-teal-500/25',
  $identify: 'bg-sky-500/15 text-sky-400 border-sky-500/25',
  $feature_flag_called: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  $pageleave: 'bg-slate-500/15 text-slate-300 border-slate-500/25',
  custom: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
}

// Palette for custom events — each name gets a stable color by hashing, so two
// distinct custom events (signup_completed vs subscription_purchased) never
// share a badge color. Full class strings are literal so Tailwind emits them.
const eventPalette: readonly string[] = [
  'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  'bg-rose-500/15 text-rose-400 border-rose-500/25',
  'bg-indigo-500/15 text-indigo-400 border-indigo-500/25',
  'bg-orange-500/15 text-orange-400 border-orange-500/25',
  'bg-cyan-500/15 text-cyan-400 border-cyan-500/25',
  'bg-pink-500/15 text-pink-400 border-pink-500/25',
  'bg-lime-500/15 text-lime-400 border-lime-500/25',
  'bg-fuchsia-500/15 text-fuchsia-400 border-fuchsia-500/25',
  'bg-blue-500/15 text-blue-400 border-blue-500/25',
  'bg-purple-500/15 text-purple-400 border-purple-500/25',
]

function eventTypeClass(type: string): string {
  const known = eventTypeStyles[type]
  if (known) return known
  // Deterministic hash → palette index (stable per event name).
  let hash = 0
  for (let i = 0; i < type.length; i += 1) hash = (hash * 31 + type.charCodeAt(i)) >>> 0
  return eventPalette[hash % eventPalette.length]
}

export function EventTypeBadge({ type }: { type: string }) {
  return (
    <span
      className={cn(
        'text-[10px] font-mono px-1.5 py-0.5 rounded border font-medium uppercase tracking-wide inline-block',
        eventTypeClass(type),
      )}
    >
      {type}
    </span>
  )
}

const statusStyles: Record<string, string> = {
  active: 'bg-teal-500/15 text-teal-400',
  churned: 'bg-red-500/15 text-red-400',
  new: 'bg-blue-500/15 text-blue-400',
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'text-[10px] font-medium px-2 py-0.5 rounded-full',
        statusStyles[status] ?? 'bg-muted text-muted-foreground',
      )}
    >
      {status}
    </span>
  )
}

/** Shown next to an event row/detail when ClickHouse marked it schema-invalid. */
export function SchemaInvalidBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/25">
      Invalid schema
    </span>
  )
}
