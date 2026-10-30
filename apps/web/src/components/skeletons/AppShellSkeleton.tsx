import { MousePointer } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { SkeletonList, SkeletonStatRow, SkeletonTable } from './index'

/**
 * Stands in for the whole `AppShell` while the session is being checked (`RequireAuth`).
 * Mirrors AppShell.tsx:200-238 — same 216px sidebar, same mobile topbar — so the real shell
 * snaps in without a reflow instead of white-flashing.
 */
export function AppShellSkeleton() {
  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      <aside className="hidden md:flex w-[216px] bg-sidebar border-r border-sidebar-border flex-col shrink-0 h-full">
        <div className="flex items-center gap-2.5 px-4 py-[13px] border-b border-sidebar-border shrink-0">
          <div className="w-6 h-6 rounded-md bg-primary flex items-center justify-center shrink-0">
            <MousePointer className="w-3 h-3 text-primary-foreground" />
          </div>
          <span className="font-semibold text-sm tracking-tight text-foreground">
            click<span className="text-primary">room</span>
          </span>
        </div>
        <div className="p-3">
          <Skeleton className="h-8 w-full" />
        </div>
        <nav className="flex flex-col gap-1.5 px-3 flex-1">
          {Array.from({ length: 12 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </nav>
        <div className="border-t border-sidebar-border p-3">
          <SkeletonList rows={1} avatar />
        </div>
      </aside>

      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        <div className="flex md:hidden items-center gap-2.5 px-4 py-[13px] border-b border-sidebar-border shrink-0">
          <Skeleton className="size-5" />
          <div className="w-6 h-6 rounded-md bg-primary flex items-center justify-center shrink-0">
            <MousePointer className="w-3 h-3 text-primary-foreground" />
          </div>
          <span className="font-semibold text-sm tracking-tight text-foreground">
            click<span className="text-primary">room</span>
          </span>
        </div>

        <main className="flex-1 overflow-auto flex flex-col min-w-0 gap-6 p-6">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-72" />
          </div>
          <SkeletonStatRow />
          <div className="bg-card border border-border rounded-lg">
            <SkeletonTable rows={6} cols={4} />
          </div>
        </main>
      </div>
    </div>
  )
}
