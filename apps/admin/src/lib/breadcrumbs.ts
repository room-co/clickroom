import type { AdminNavGroup } from '@/components/app-shell/nav-groups'

export interface BreadcrumbSegment {
  label: string
  /** Path to link to; the last segment has none (it's the current page). */
  to?: string
}

/**
 * Pure path → breadcrumb derivation. Driven off `nav-groups.ts`
 * data rather than a hand-maintained label map, so a nav entry's label is
 * defined once. Segments below a known nav path (e.g. an `:id` under
 * `/orgs/:id`) render as a shortened token rather than the raw slug/id, and
 * an unrecognized top-level path still produces a sane trail instead of
 * throwing — this runs on every route change, so it must never crash.
 */
export function getBreadcrumbs(pathname: string, groups: AdminNavGroup[]): BreadcrumbSegment[] {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length === 0) return [{ label: 'Dashboard', to: '/dashboard' }]

  const labelByPath = new Map<string, string>()
  for (const group of groups) {
    for (const item of group.items) {
      labelByPath.set(item.path, item.label)
    }
  }

  let acc = ''
  return parts.map((part, index) => {
    acc += `/${part}`
    const isLast = index === parts.length - 1
    const label = labelByPath.get(acc) ?? formatSegment(part)
    return isLast ? { label } : { label, to: acc }
  })
}

function formatSegment(part: string): string {
  if (!part) return '—'
  // Looks like an id/slug (ulid/uuid/token) rather than a human label —
  // shorten instead of dumping the raw value into the trail.
  if (part.length > 12) return `${part.slice(0, 8)}…`
  return part
}
