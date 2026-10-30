import type { LucideIcon } from 'lucide-react'
import { Activity, Building2, FileClock, Gauge, LayoutDashboard } from 'lucide-react'

export interface AdminNavItem {
  label: string
  path: string
  icon: LucideIcon
}

export interface AdminNavGroup {
  label: string
  items: AdminNavItem[]
}

/**
 * Grouped sidebar nav declared as plain data. Groups and paths match
 * planned route list (`/dashboard`, `/orgs`, `/usage`, `/health`,
 * `/audit`) so the Sidebar, CommandPalette, and breadcrumb derivation
 * (`lib/breadcrumbs.ts`) all read from one source instead of drifting.
 */
export const NAV_GROUPS: AdminNavGroup[] = [
  {
    label: 'Overview',
    items: [{ label: 'Dashboard', path: '/dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'Orgs',
    items: [{ label: 'Orgs', path: '/orgs', icon: Building2 }],
  },
  {
    label: 'Usage',
    items: [{ label: 'Usage', path: '/usage', icon: Gauge }],
  },
  {
    label: 'Platform',
    items: [
      { label: 'Health', path: '/health', icon: Activity },
      { label: 'Audit', path: '/audit', icon: FileClock },
    ],
  },
]

/** Flat list of every nav item across groups — used by the command palette. */
export const ALL_NAV_ITEMS: AdminNavItem[] = NAV_GROUPS.flatMap((group) => group.items)
