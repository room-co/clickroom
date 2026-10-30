import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router'
import { CommandPalette } from '@/components/app-shell/CommandPalette'
import { ShellFooter } from '@/components/app-shell/ShellFooter'
import { SidebarNav } from '@/components/app-shell/Sidebar'
import { Topbar } from '@/components/app-shell/Topbar'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'

/** Global ⌘K / Ctrl+K listener that opens the command palette from anywhere in the shell. */
function useCommandPaletteShortcut(onOpen: () => void) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        onOpen()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onOpen])
}

/**
 * Admin console shell: a grouped sidebar (desktop `<aside>` below
 * `md`, an off-canvas `Sheet` above it — CLAUDE.md's responsiveness rules), a
 * topbar (breadcrumb + ⌘K trigger), the `<Outlet>` content area, and a
 * persistent identity footer that is *not* inside the collapsible sidebar so
 * it stays visible at every breakpoint (see `ShellFooter`'s doc comment for
 * why). Standalone/self-contained: assumes it's rendered somewhere
 * already-authenticated — it does not itself gate access.
 * `ProtectedAdminRoute` (or the router tree it builds) is expected to render
 * this as the authenticated layout once it lands.
 */
export function AppShell() {
  const location = useLocation()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  useCommandPaletteShortcut(() => setPaletteOpen(true))

  // biome-ignore lint/correctness/useExhaustiveDependencies: close the mobile sheet on route change
  useEffect(() => {
    setMobileNavOpen(false)
  }, [location.pathname])

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[220px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
          <SidebarNav />
        </aside>

        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="flex w-[240px] flex-col gap-0 bg-sidebar p-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SidebarNav />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar
            onOpenMobileNav={() => setMobileNavOpen(true)}
            onOpenPalette={() => setPaletteOpen(true)}
          />
          <main className="min-h-0 flex-1 overflow-auto">
            <Outlet />
          </main>
        </div>
      </div>

      <ShellFooter />

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  )
}
