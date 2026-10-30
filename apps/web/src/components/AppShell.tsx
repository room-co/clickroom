import {
  Activity,
  BarChart3,
  Bot,
  ChevronDown,
  Database,
  FlaskConical,
  FolderKanban,
  Globe,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Menu,
  MessageSquareText,
  MousePointer,
  Rocket,
  Settings,
  Sparkles,
  TerminalSquare,
  ToggleLeft,
  TrendingDown,
  Users,
  Users2,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { ImpersonationBanner } from '@/components/ImpersonationBanner'
import { ProjectSelector } from '@/components/ProjectSelector'
import { SkeletonList } from '@/components/skeletons'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { IDENTIFY_SIG_STORAGE_KEY, identifyUser, setAnalyticsOrgContext } from '@/lib/analytics'
import { logout } from '@/lib/session'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { useEntitlement } from '@/lib/use-entitlement'
import { useInternalFlag } from '@/lib/use-internal-flag'
import { cn } from '@/lib/utils'

type NavItem = {
  label: string
  to: string
  end?: boolean
  icon: ComponentType<{ className?: string }>
}

const navItems: NavItem[] = [
  { label: 'Dashboard', to: '/', end: true, icon: LayoutDashboard },
  { label: 'Ask AI', to: '/ask-ai', icon: Sparkles },
  { label: 'Web Analytics', to: '/web-analytics', icon: Globe },
  { label: 'Events', to: '/events', icon: Activity },
  { label: 'Funnels', to: '/funnels', icon: TrendingDown },
  { label: 'Feature Flags', to: '/flags', icon: ToggleLeft },
  { label: 'Users', to: '/users', icon: Users },
  { label: 'Segments', to: '/segments', icon: Users2 },
  { label: 'Experiments', to: '/experiments', icon: FlaskConical },
  { label: 'Surveys', to: '/surveys', icon: MessageSquareText },
  { label: 'Support', to: '/support', icon: LifeBuoy },
  { label: 'Product analytics', to: '/insights', icon: BarChart3 },
  { label: 'SQL Explorer', to: '/sql', icon: TerminalSquare },
  { label: 'Setup', to: '/setup', icon: Rocket },
  { label: 'Projects', to: '/projects', icon: FolderKanban },
  { label: 'API Keys', to: '/api-keys', icon: KeyRound },
  { label: 'MCP Server', to: '/mcp', icon: Bot },
  { label: 'Data Management', to: '/data-management', icon: Database },
]

const navItemClass = (isActive: boolean) =>
  cn(
    'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded text-sm transition-colors text-left',
    isActive
      ? 'bg-primary/10 text-primary font-medium'
      : 'text-muted-foreground hover:text-foreground hover:bg-muted/30',
  )

function initialsFrom(name: string | null | undefined, email: string): string {
  const trimmed = name?.trim()
  if (trimmed) {
    const words = trimmed.split(/\s+/).filter(Boolean)
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  }
  return email.slice(0, 2).toUpperCase()
}

function UserFooter() {
  const { data } = trpc.auth.me.useQuery()

  if (!data) {
    return (
      <div className="px-3 py-3 border-t border-sidebar-border">
        <SkeletonList rows={1} avatar />
      </div>
    )
  }

  const { user } = data
  const name = user.name?.trim() || user.email.split('@')[0]

  return (
    <div className="px-3 py-3 border-t border-sidebar-border">
      <div className="flex items-center gap-2.5">
        <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center text-[9px] font-bold text-primary-foreground shrink-0">
          {initialsFrom(user.name, user.email)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-medium text-foreground truncate">{name}</div>
          <div className="text-[10px] text-muted-foreground truncate">{user.email}</div>
        </div>
        <button type="button" onClick={() => logout()} aria-label="Log out">
          <LogOut className="w-3 h-3 text-muted-foreground hover:text-foreground cursor-pointer transition-colors shrink-0" />
        </button>
      </div>
    </div>
  )
}

function SidebarContent() {
  // SQL Explorer has two gates, both evaluated here so the
  // hooks stay unconditional (Rules of Hooks — no hook calls inside the
  // `.filter()` below):
  //   - `internal-sql-explorer`: the rollout kill-switch. `false` with no write
  //     key, so self-hosted/local builds don't show the item. Intended.
  //   - the plan entitlement: fails *open* while the summary loads.
  // Both are hints — `entitlementMiddleware` on `sqlExplorer.*` is the real gate.
  const sqlFlagEnabled = useInternalFlag('internal-sql-explorer', true)
  const sqlEntitled = useEntitlement('feature:sql_explorer').allowed
  const showSqlExplorer = sqlFlagEnabled && sqlEntitled

  // Surveys is a plan-gated feature — hide the nav item for
  // orgs without the `feature:surveys` entitlement. Fails open while the
  // entitlement summary loads (see useEntitlement). The route guard +
  // `entitlementMiddleware` are the real gates.
  const surveysEntitled = useEntitlement('feature:surveys').allowed

  // Same posture as surveys — hide the nav item for orgs
  // without `feature:support`; the route guard + `entitlementMiddleware` on
  // `support.*` are the real gates.
  const supportEntitled = useEntitlement('feature:support').allowed

  const items = navItems.filter((item) => {
    if (item.to === '/sql') return showSqlExplorer
    if (item.to === '/surveys') return surveysEntitled
    if (item.to === '/support') return supportEntitled
    return true
  })

  return (
    <>
      {/* Logo */}
      <div className="px-4 py-[13px] border-b border-sidebar-border flex items-center gap-2.5">
        <div className="w-6 h-6 rounded-md bg-primary flex items-center justify-center shrink-0">
          <MousePointer className="w-3 h-3 text-primary-foreground" />
        </div>
        <span className="font-semibold text-sm tracking-tight text-foreground">
          click<span className="text-primary">room</span>
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground ml-auto" />
      </div>

      {/* Project selector */}
      <div className="px-3 py-2.5 border-b border-sidebar-border">
        <ProjectSelector />
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {items.map(({ label, to, end, icon: Icon }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => navItemClass(isActive)}>
            <Icon className="w-3.5 h-3.5 shrink-0" />
            {label}
          </NavLink>
        ))}

        <div className="pt-2 mt-2 border-t border-sidebar-border">
          <NavLink to="/settings" className={({ isActive }) => navItemClass(isActive)}>
            <Settings className="w-3.5 h-3.5 shrink-0" />
            Settings
          </NavLink>
        </div>
      </nav>

      {/* User */}
      <UserFooter />
    </>
  )
}

export function AppShell() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const location = useLocation()
  const { user, org, role, isLoading } = useAuth()

  // biome-ignore lint/correctness/useExhaustiveDependencies: close sheet when route changes
  useEffect(() => {
    setMobileNavOpen(false)
  }, [location.pathname])

  // Dogfooding: identify the current user with the internal Clickroom
  // project once auth resolves. No-ops if analytics isn't configured.
  // `user`/`org` are new object references on every `auth.me` refetch (React
  // Query), so a plain [user, org] dep array would re-fire identify() on
  // every dashboard refresh — dedupe on a value signature instead, mirroring
  // the common `lastSig` guard pattern. The SDK's identify() has
  // no dedup of its own (always emits `$identify`), and a `useRef` alone only
  // survives SPA navigation, not a hard browser reload (React state resets)
  // — persist the signature in sessionStorage so it survives a reload within
  // the same tab and only re-fires on an actual identity change.
  const lastIdentifySig = useRef<string | null>(
    typeof window !== 'undefined' ? window.sessionStorage.getItem(IDENTIFY_SIG_STORAGE_KEY) : null,
  )
  useEffect(() => {
    if (isLoading || !user || !org) return
    // Always re-set org context — it's a module-level var that resets to
    // undefined on every fresh page load, unlike the sessionStorage-backed
    // identify dedup below, so it must not be skipped when identify is.
    setAnalyticsOrgContext(org.id)
    const sig = `${user.id}:${org.id}:${role}`
    if (lastIdentifySig.current === sig) return
    lastIdentifySig.current = sig
    window.sessionStorage.setItem(IDENTIFY_SIG_STORAGE_KEY, sig)
    identifyUser(user.id, {
      email: user.email,
      org_id: org.id,
      org_name: org.name,
      role,
    })
  }, [isLoading, user, org, role])

  return (
    <div className="flex h-screen flex-col bg-background text-foreground overflow-hidden">
      <ImpersonationBanner />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <aside className="hidden md:flex w-[216px] bg-sidebar border-r border-sidebar-border flex-col shrink-0 h-full">
          <SidebarContent />
        </aside>

        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="w-[216px] p-0 bg-sidebar flex flex-col gap-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SidebarContent />
          </SheetContent>
        </Sheet>

        <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
          <div className="flex md:hidden items-center gap-2.5 px-4 py-[13px] border-b border-sidebar-border shrink-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation"
              className="p-1 -ml-1 text-muted-foreground hover:text-foreground transition-colors"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="w-6 h-6 rounded-md bg-primary flex items-center justify-center shrink-0">
              <MousePointer className="w-3 h-3 text-primary-foreground" />
            </div>
            <span className="font-semibold text-sm tracking-tight text-foreground">
              click<span className="text-primary">room</span>
            </span>
          </div>

          <main className="flex-1 overflow-hidden flex flex-col min-w-0">
            <div className="flex-1 overflow-auto">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
