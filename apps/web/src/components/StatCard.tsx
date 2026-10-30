import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import type { ComponentType } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export function StatCard({
  icon: Icon,
  label,
  value,
  change,
  loading = false,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: string
  change?: number | null
  loading?: boolean
}) {
  const positive = change === undefined || change === null || change >= 0
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3 hover:border-border/80 transition-colors">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          {label}
        </span>
        <div className="w-6 h-6 rounded bg-primary/10 flex items-center justify-center">
          <Icon className="w-3.5 h-3.5 text-primary" />
        </div>
      </div>
      <div className="flex items-end justify-between">
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <div className="font-mono text-2xl font-semibold text-foreground tracking-tight">
            {value}
          </div>
        )}
        {/* `change` is undefined while the query is in flight, so the trend slot is reserved
            off `loading` — gating it on `change !== undefined` would drop the row mid-load. */}
        {loading && <Skeleton className="h-4 w-10" />}
        {!loading && change !== undefined && (
          <div
            className={cn(
              'flex items-center gap-0.5 text-[11px] font-medium font-mono',
              change === null
                ? 'text-muted-foreground'
                : positive
                  ? 'text-primary'
                  : 'text-red-400',
            )}
          >
            {change === null ? (
              '—'
            ) : (
              <>
                {positive ? (
                  <ArrowUpRight className="w-3.5 h-3.5" />
                ) : (
                  <ArrowDownRight className="w-3.5 h-3.5" />
                )}
                {Math.abs(change)}%
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
