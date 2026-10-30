import type { ComponentType } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * Composite skeletons. Each mirrors the shape of the content it stands in for — right row count,
 * right column widths, right card chrome — so nothing jumps when the real data lands.
 *
 * Rules: skeletons on FIRST load only (`isPending` / `!data`), never on background
 * refetch. Spinners are for mutations, not data fetches.
 */

/** Deterministic width jitter so rows don't read as a solid block. */
const CELL_WIDTHS = ['w-full', 'w-4/5', 'w-2/3', 'w-3/4', 'w-1/2', 'w-5/6']
const cellWidth = (i: number) => CELL_WIDTHS[i % CELL_WIDTHS.length]

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
          key={i}
          className={cn('h-4', i === lines - 1 ? 'w-3/5' : 'w-full')}
        />
      ))}
    </div>
  )
}

export function SkeletonTable({
  rows = 6,
  cols = 4,
  header = true,
  className,
}: {
  rows?: number
  cols?: number
  header?: boolean
  className?: string
}) {
  const grid = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }
  return (
    <div className={cn('flex flex-col gap-3 p-4', className)}>
      {header && (
        <div className="grid gap-4 pb-1 border-b border-border" style={grid}>
          {Array.from({ length: cols }).map((_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={c} className="h-3 w-16" />
          ))}
        </div>
      )}
      {Array.from({ length: rows }).map((_, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
        <div key={r} className="grid gap-4 items-center" style={grid}>
          {Array.from({ length: cols }).map((_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={c} className={cn('h-5', cellWidth(r + c))} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function SkeletonCard({
  className,
  lines = 3,
  title = true,
}: {
  className?: string
  lines?: number
  title?: boolean
}) {
  return (
    <div
      className={cn('bg-card border border-border rounded-lg p-4 flex flex-col gap-3', className)}
    >
      {title && <Skeleton className="h-4 w-32" />}
      <SkeletonText lines={lines} />
    </div>
  )
}

/** Bar-chart shell: axis rail + staggered columns, so it doesn't read as one flat block. */
const BAR_HEIGHTS = [
  'h-[40%]',
  'h-[70%]',
  'h-[55%]',
  'h-[85%]',
  'h-[35%]',
  'h-[65%]',
  'h-[50%]',
  'h-[75%]',
  'h-[45%]',
  'h-[60%]',
  'h-[80%]',
  'h-[30%]',
]

export function SkeletonChart({
  height = 220,
  bars = 12,
  className,
}: {
  height?: number
  bars?: number
  className?: string
}) {
  return (
    <div className={cn('flex gap-3 w-full', className)} style={{ height: `${height}px` }}>
      <div className="flex flex-col justify-between py-1 shrink-0">
        {Array.from({ length: 4 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
          <Skeleton key={i} className="h-2.5 w-8" />
        ))}
      </div>
      <div className="flex flex-1 items-end gap-1.5 border-b border-border pb-2">
        {Array.from({ length: bars }).map((_, i) => (
          <Skeleton
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            key={i}
            className={cn('flex-1 rounded-sm', BAR_HEIGHTS[i % BAR_HEIGHTS.length])}
          />
        ))}
      </div>
    </div>
  )
}

export function SkeletonList({
  rows = 5,
  avatar = false,
  className,
}: {
  rows?: number
  avatar?: boolean
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
        <div key={i} className="flex items-center gap-2.5">
          {avatar && <Skeleton className="size-8 shrink-0 rounded-full" />}
          <div className="flex flex-1 flex-col gap-1.5 min-w-0">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Mirrors `components/StatCard.tsx` chrome exactly so the tile doesn't resize on load.
 * Pass the real icon when you have it — keeping it visible makes the shell feel like the page.
 */
export function SkeletonStatCard({
  icon: Icon,
  label,
  className,
}: {
  icon?: ComponentType<{ className?: string }>
  label?: string
  className?: string
}) {
  return (
    <div
      className={cn('bg-card border border-border rounded-lg p-4 flex flex-col gap-3', className)}
    >
      <div className="flex items-center justify-between">
        {label ? (
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            {label}
          </span>
        ) : (
          <Skeleton className="h-2.5 w-20" />
        )}
        <div className="w-6 h-6 rounded bg-primary/10 flex items-center justify-center">
          {Icon ? <Icon className="w-3.5 h-3.5 text-primary" /> : null}
        </div>
      </div>
      <div className="flex items-end justify-between">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-4 w-10" />
      </div>
    </div>
  )
}

export function SkeletonStatRow({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3', className)}>
      {Array.from({ length: count }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
        <SkeletonStatCard key={i} />
      ))}
    </div>
  )
}
