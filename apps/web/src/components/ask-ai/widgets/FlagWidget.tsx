// Renders flag_get (single flag) / flags_list (list) tool output. Read-only —
// reuses FlagsPage.tsx's badge/toggle conventions (FlagBits.tsx) so a flag
// looks the same here as it does on the Flags page. Any actual toggle/update
// still goes through ApprovalGate (shell/), not this component.

import { formatTimestamp } from '@/lib/format'
import { EnvBadge, type FeatureFlagRow, FlagToggle, KindBadge } from '@/pages/flags/FlagBits'
import { rolloutSummary, toFlagFilters } from '@/pages/flags/types'

function VariantList({ filters }: { filters: unknown }) {
  const parsed = toFlagFilters(filters)
  if (!parsed.multivariate || parsed.multivariate.variants.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {parsed.multivariate.variants.map((v) => (
        <span
          key={v.key}
          className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
        >
          {v.key} · {v.rollout_percentage}%
        </span>
      ))}
    </div>
  )
}

export function FlagWidget({ flag }: { flag: FeatureFlagRow }) {
  return (
    <div className="w-full min-w-0 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <FlagToggle enabled={flag.active} onToggle={() => {}} size="sm" disabled />
          <span className="truncate text-sm font-medium text-foreground">
            {flag.name ?? flag.key}
          </span>
        </div>
        <KindBadge filters={toFlagFilters(flag.filters)} />
      </div>
      <div className="mt-2 font-mono text-[11px] text-muted-foreground">{flag.key}</div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className="text-[11px] text-muted-foreground">{rolloutSummary(flag.filters)}</span>
        <EnvBadge env={flag.env} />
      </div>

      <div className="mt-3">
        <VariantList filters={flag.filters} />
      </div>

      {flag.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {flag.tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 border-t border-border pt-2 text-[10px] text-muted-foreground">
        Updated {formatTimestamp(flag.updatedAt)} · v{flag.version}
      </div>
    </div>
  )
}

export function FlagsListWidget({ flags }: { flags: FeatureFlagRow[] }) {
  if (flags.length === 0) {
    return (
      <div className="w-full min-w-0 rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
        No flags found.
      </div>
    )
  }
  return (
    <div className="w-full min-w-0 overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full min-w-[420px] border-collapse text-xs">
        <thead>
          <tr className="border-b border-border">
            <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Flag
            </th>
            <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Kind
            </th>
            <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Targeting
            </th>
            <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Env
            </th>
          </tr>
        </thead>
        <tbody>
          {flags.map((flag) => (
            <tr key={flag.id} className="border-b border-border/50 last:border-0">
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <FlagToggle enabled={flag.active} onToggle={() => {}} size="sm" disabled />
                  <span className="truncate font-medium text-foreground">
                    {flag.name ?? flag.key}
                  </span>
                </div>
              </td>
              <td className="px-3 py-2">
                <KindBadge filters={toFlagFilters(flag.filters)} />
              </td>
              <td className="px-3 py-2 text-muted-foreground">{rolloutSummary(flag.filters)}</td>
              <td className="px-3 py-2">
                <EnvBadge env={flag.env} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
