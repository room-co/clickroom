import { Menu, Search } from 'lucide-react'
import { Fragment } from 'react'
import { Link, useLocation } from 'react-router'
import { Button } from '@/components/ui/button'
import { getBreadcrumbs } from '@/lib/breadcrumbs'
import { NAV_GROUPS } from './nav-groups'

export interface TopbarProps {
  onOpenMobileNav: () => void
  onOpenPalette: () => void
}

/** Topbar: mobile hamburger, breadcrumb trail (from `lib/breadcrumbs.ts`), ⌘K trigger. */
export function Topbar({ onOpenMobileNav, onOpenPalette }: TopbarProps) {
  const location = useLocation()
  const crumbs = getBreadcrumbs(location.pathname, NAV_GROUPS)

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onOpenMobileNav}
        aria-label="Open navigation"
      >
        <Menu className="size-4" />
      </Button>

      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-sm">
          {crumbs.map((crumb, index) => (
            <Fragment key={crumb.to ?? `${crumb.label}-current`}>
              {index > 0 && <span className="text-muted-foreground">/</span>}
              <li className="min-w-0 truncate">
                {crumb.to ? (
                  <Link to={crumb.to} className="text-muted-foreground hover:text-foreground">
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="font-medium text-foreground">{crumb.label}</span>
                )}
              </li>
            </Fragment>
          ))}
        </ol>
      </nav>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onOpenPalette}
        className="hidden shrink-0 gap-1.5 text-muted-foreground sm:flex"
      >
        <Search className="size-3.5" />
        <span>Jump to…</span>
        <kbd className="ml-1 rounded border border-border bg-muted px-1 text-[10px]">⌘K</kbd>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onOpenPalette}
        className="shrink-0 sm:hidden"
        aria-label="Open command palette"
      >
        <Search className="size-4" />
      </Button>
    </div>
  )
}
