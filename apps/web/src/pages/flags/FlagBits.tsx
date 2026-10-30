import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { type FlagFilters, flagKind } from './types'

// Runtime shape of a FeatureFlag row (dates/enums serialize as strings on the
// wire; no tRPC transformer is configured, so we narrow here).
export type FeatureFlagRow = {
  id: string
  key: string
  name: string | null
  active: boolean
  /** whether reads emit $feature_flag_called exposures. */
  track: boolean
  filters: unknown
  version: number
  env: string
  tags: string[]
  updatedAt: string
}

// Deterministic fallback palette for environments with no `color` set —
// keyed by a hash of the slug so a given env always lands on the same swatch,
// rather than a fixed union of exactly 3 literal env names.
const FALLBACK_ENV_PALETTE = [
  'text-teal-400 bg-teal-500/10',
  'text-amber-400 bg-amber-500/10',
  'text-violet-400 bg-violet-500/10',
  'text-sky-400 bg-sky-500/10',
  'text-fuchsia-400 bg-fuchsia-500/10',
  'text-lime-400 bg-lime-500/10',
]

// Hex twins of FALLBACK_ENV_PALETTE (same index = same swatch), for contexts
// that need a literal color value (box-shadow/border) rather than utility classes.
const FALLBACK_ENV_HEX = [
  '#2dd4bf', // teal-400
  '#fbbf24', // amber-400
  '#a78bfa', // violet-400
  '#38bdf8', // sky-400
  '#e879f9', // fuchsia-400
  '#a3e635', // lime-400
]

function envHash(slug: string): number {
  let hash = 0
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) >>> 0
  return hash
}

export function fallbackEnvStyle(slug: string): string {
  return FALLBACK_ENV_PALETTE[envHash(slug) % FALLBACK_ENV_PALETTE.length]
}

/** Same deterministic pick as `fallbackEnvStyle`, as a literal hex for glow/shadow use. */
export function fallbackEnvColor(slug: string): string {
  return FALLBACK_ENV_HEX[envHash(slug) % FALLBACK_ENV_HEX.length]
}

/** CSS custom property carrying an environment's neon glow color — falls back to the
 * deterministic swatch when the environment has no stored `color`. Spread onto the
 * element that also carries `ENV_TAB_GLOW_CLASS` (or any consumer of `--tab-glow`). */
export function envGlowVars(color: string | null | undefined, slug: string): CSSProperties {
  return { '--tab-glow': color || fallbackEnvColor(slug) } as CSSProperties
}

/** Neon glow treatment for the *active* environment tab only — colored border, soft
 * outer glow, faint inner glow, and tinted text, all driven by the `--tab-glow` custom
 * property set via `envGlowVars`. Unselected tabs are untouched (stay on the default
 * shadcn muted style from `components/ui/tabs.tsx`). */
export const ENV_TAB_GLOW_CLASS =
  'data-[state=active]:border-[var(--tab-glow)] data-[state=active]:text-[var(--tab-glow)] ' +
  'data-[state=active]:shadow-[0_0_0_1px_var(--tab-glow),0_0_14px_-1px_var(--tab-glow),0_0_28px_-6px_var(--tab-glow),inset_0_0_8px_-3px_var(--tab-glow)] ' +
  'data-[state=active]:dark:bg-[color-mix(in_oklab,var(--tab-glow)_14%,transparent)]'

export function EnvBadge({ env, color }: { env: string; color?: string | null }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-medium capitalize',
        !color && fallbackEnvStyle(env),
      )}
      style={color ? { color, backgroundColor: `${color}1a` } : undefined}
    >
      {env}
    </span>
  )
}

const flagKindStyle: Record<string, string> = {
  boolean: 'text-sky-400 bg-sky-500/10',
  string: 'text-fuchsia-400 bg-fuchsia-500/10',
  number: 'text-lime-400 bg-lime-500/10',
}

const flagKindLabel: Record<string, string> = {
  boolean: 'Boolean',
  string: 'String',
  number: 'Number',
}

export function KindBadge({ filters }: { filters: FlagFilters }) {
  const kind = flagKind(filters)
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[10px] font-medium capitalize',
        flagKindStyle[kind] ?? 'bg-muted text-muted-foreground',
      )}
    >
      {flagKindLabel[kind] ?? kind}
    </span>
  )
}

/** Raw-tailwind toggle from the source design. `size` sets list vs header scale.
 * `disabled` keeps the toggle in place (part of a row/header layout) but blocks
 * interaction — used for viewers who lack `flags:write`. */
export function FlagToggle({
  enabled,
  onToggle,
  size = 'md',
  disabled = false,
}: {
  enabled: boolean
  onToggle: () => void
  size?: 'sm' | 'md'
  disabled?: boolean
}) {
  const track = size === 'sm' ? 'w-8 h-4' : 'w-10 h-5'
  const knob = size === 'sm' ? 'w-3 h-3' : 'w-4 h-4'
  const shift = size === 'sm' ? 'translate-x-4' : 'translate-x-5'
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      aria-label={enabled ? 'Disable flag' : 'Enable flag'}
      className={cn(
        'relative shrink-0 overflow-hidden rounded-full transition-colors',
        track,
        enabled ? 'bg-primary' : 'bg-muted',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'absolute left-0.5 top-0.5 rounded-full bg-white shadow-sm transition-transform',
          knob,
          enabled ? shift : 'translate-x-0',
        )}
      />
    </button>
  )
}

export function KpiCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-4">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-2xl font-semibold text-foreground">{value}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>
    </div>
  )
}
