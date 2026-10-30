import { MousePointer } from 'lucide-react'
import { NavLink } from 'react-router'
import { cn } from '@/lib/utils'
import { NAV_GROUPS } from './nav-groups'

const navItemClass = (isActive: boolean) =>
  cn(
    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
    isActive
      ? 'bg-accent text-accent-foreground font-medium'
      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
  )

/**
 * Grouped nav content, rendered as-is by both the desktop `<aside>` and the
 * mobile off-canvas `Sheet` in `AppShell` — one implementation, two shells,
 * per CLAUDE.md's responsiveness rules (mobile nav goes through
 * `components/ui/sheet.tsx`, not a hand-rolled drawer).
 */
export function SidebarNav() {
  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-sidebar-border px-4 py-[13px]">
        <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary">
          <MousePointer className="size-3.5 text-primary-foreground" />
        </div>
        <span className="text-sm font-semibold tracking-tight text-sidebar-foreground">
          clickroom <span className="text-primary">admin</span>
        </span>
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto px-2 py-3">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="px-2.5 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              {group.label}
            </div>
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={({ isActive }) => navItemClass(isActive)}
                >
                  <item.icon className="size-3.5 shrink-0" />
                  {item.label}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
    </>
  )
}
