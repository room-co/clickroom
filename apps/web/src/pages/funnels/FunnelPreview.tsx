import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { SkeletonChart } from '@/components/skeletons'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

// Teal drop-off palette, darkening down the funnel (mirrors the design system).
export const FUNNEL_COLORS = ['#2DD4BF', '#26b8a6', '#1fa08e', '#178878', '#107062']

export const funnelColor = (i: number) => FUNNEL_COLORS[Math.min(i, FUNNEL_COLORS.length - 1)]

// Color a conversion percentage by threshold: <25 red, <60 amber, else teal.
export function convClass(pct: number): string {
  if (pct < 25) return 'text-red-400'
  if (pct < 60) return 'text-amber-400'
  return 'text-teal-400'
}

export interface FunnelResultRow {
  step: number
  label: string
  alias?: string
  count: number
  conversionPct: number
  dropoffPct: number
}

export interface FunnelPreviewProps {
  rows: FunnelResultRow[]
  displayLabel: (r: { label: string; alias?: string }) => string
  windowLabel: string
  state: 'idle' | 'loading' | 'error' | 'empty' | 'ready'
  errorMessage?: string
  idleHint?: string
}

/** Funnel drop-off bar chart + step-breakdown table, shared by the funnel detail
 * page and the funnel builder's live preview. */
export function FunnelPreview({
  rows,
  displayLabel,
  windowLabel,
  state,
  errorMessage,
  idleHint,
}: FunnelPreviewProps) {
  const entered = rows[0]?.count ?? 0

  // Chart data: stacked bar (reached users + dropped remainder), total = entered.
  const chartData = rows.map((r) => ({
    name: displayLabel(r).length > 18 ? `${displayLabel(r).slice(0, 17)}…` : displayLabel(r),
    fullName: displayLabel(r),
    users: r.count,
    rest: Math.max(0, entered - r.count),
    pct: r.conversionPct,
  }))

  return (
    <>
      {/* Funnel drop-off bar chart */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-5">
          <div>
            <div className="text-sm font-medium text-foreground">Funnel drop-off</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              Each bar shows users who reached that step relative to total entered
            </div>
          </div>
          <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span
                className="w-2.5 h-2.5 rounded-sm inline-block"
                style={{ background: FUNNEL_COLORS[0] }}
              />
              Reached step
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm inline-block bg-muted/40" />
              Dropped off
            </span>
          </div>
        </div>
        {state === 'idle' ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            {idleHint ?? 'Add at least two steps to run the funnel.'}
          </div>
        ) : state === 'loading' ? (
          <SkeletonChart height={240} />
        ) : state === 'error' ? (
          <Alert variant="destructive">
            <AlertTitle>Failed to run funnel</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : state === 'empty' ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            No conversion data for these steps.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={rows.length * 52}>
            <BarChart
              layout="vertical"
              data={chartData}
              margin={{ top: 0, right: 96, left: 0, bottom: 0 }}
              barSize={32}
            >
              <XAxis type="number" domain={[0, entered]} hide />
              <YAxis
                type="category"
                dataKey="name"
                width={150}
                tick={{ fontSize: 11, fill: '#E2E2EE' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0].payload as (typeof chartData)[number]
                  return (
                    <div className="bg-popover border border-border rounded-lg px-3 py-2.5 shadow-xl text-xs space-y-1">
                      <div className="font-medium text-foreground">{d.fullName}</div>
                      <div className="font-mono text-muted-foreground">
                        {formatNumber(d.users)} users
                      </div>
                      <div className="font-mono text-primary">{d.pct}% of total</div>
                    </div>
                  )
                }}
              />
              <Bar dataKey="users" stackId="a" radius={[3, 0, 0, 3]}>
                {chartData.map((d, i) => (
                  <Cell key={d.fullName} fill={funnelColor(i)} fillOpacity={0.85} />
                ))}
              </Bar>
              <Bar dataKey="rest" stackId="a" fill="rgba(255,255,255,0.05)" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Step breakdown table */}
      {state === 'ready' && rows.length > 0 && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
            <div className="text-sm font-medium text-foreground">Step breakdown</div>
            <div className="text-[10px] text-muted-foreground">
              {rows.length} steps · {windowLabel} window
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/10">
                  {['#', 'Step', 'Users', '% of total', 'Step conv.', 'Drop-off'].map((h) => (
                    <th
                      key={h}
                      className="text-left px-5 py-2.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((step, i) => {
                  const prev = i > 0 ? rows[i - 1] : null
                  const dropUsers = prev ? prev.count - step.count : 0
                  const stepConv =
                    prev && prev.count > 0 ? Math.round((step.count / prev.count) * 1000) / 10 : 0
                  return (
                    <tr
                      key={step.step}
                      className="border-b border-border/50 hover:bg-muted/10 transition-colors"
                    >
                      <td className="px-5 py-3.5">
                        <div
                          className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold"
                          style={{
                            background: `${funnelColor(i)}25`,
                            color: funnelColor(i),
                          }}
                        >
                          {i + 1}
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="font-medium text-foreground">{displayLabel(step)}</div>
                      </td>
                      <td className="px-5 py-3.5 font-mono text-foreground font-semibold">
                        {formatNumber(step.count)}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2.5">
                          <div className="w-20 h-1.5 bg-muted/40 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${step.conversionPct}%`,
                                background: funnelColor(i),
                              }}
                            />
                          </div>
                          <span className={cn('font-mono text-xs', convClass(step.conversionPct))}>
                            {step.conversionPct}%
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 font-mono text-muted-foreground">
                        {i === 0 ? (
                          <span className="text-muted-foreground/40">—</span>
                        ) : (
                          `${stepConv}%`
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        {prev ? (
                          <span className="font-mono text-xs text-red-400">
                            ↓ {formatNumber(dropUsers)} ({step.dropoffPct}%)
                          </span>
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}
