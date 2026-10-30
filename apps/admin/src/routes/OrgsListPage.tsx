import { keepPreviousData } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { SkeletonTable } from '@/components/skeletons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { trpc } from '@/lib/trpc'
import { cn } from '@/lib/utils'

type SuspensionFilter = 'all' | 'active' | 'suspended'

const SUSPENSION_CHIPS: { key: SuspensionFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'suspended', label: 'Suspended' },
]

/** Debounces a value by `delayMs`, resetting the timer on every change. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(id)
  }, [value, delayMs])
  return debounced
}

/**
 * `/orgs`. Cross-tenant searchable directory via `admin.orgs.list`. `admin.orgs.list`
 * has no `suspended`-only filter param — the "Active"/"Suspended" chips below filter the
 * fetched page client-side (server search/plan filter still round-trips) rather than inventing
 * a backend param this task isn't scoped to add.
 */
export function OrgsListPage() {
  const [searchInput, setSearchInput] = useState('')
  const debouncedSearch = useDebouncedValue(searchInput, 300)
  const [suspensionFilter, setSuspensionFilter] = useState<SuspensionFilter>('all')
  const [planKeyFilter, setPlanKeyFilter] = useState<string | undefined>(undefined)

  // Unfiltered-by-plan page, used only to derive the set of plan chips to render —
  // `admin.orgs.list` has no "list distinct plans" procedure, so this is the cheapest way to
  // populate real plan options without inventing a new backend endpoint for it.
  const planOptionsQuery = trpc.admin.orgs.list.useQuery({ limit: 200 })
  const planOptions = Array.from(
    new Map(
      (planOptionsQuery.data?.orgs ?? [])
        .filter((org) => org.planKey)
        .map((org) => [org.planKey as string, org.planName ?? org.planKey] as const),
    ),
  )

  const query = trpc.admin.orgs.list.useQuery(
    { search: debouncedSearch || undefined, planKey: planKeyFilter, limit: 100 },
    { placeholderData: keepPreviousData },
  )

  const orgs = (query.data?.orgs ?? []).filter((org) => {
    if (suspensionFilter === 'active') return !org.suspendedAt
    if (suspensionFilter === 'suspended') return Boolean(org.suspendedAt)
    return true
  })

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Orgs</h1>
          <p className="text-sm text-muted-foreground">Cross-tenant directory of customer orgs.</p>
        </div>
        <div className="w-full sm:w-72">
          <Input
            placeholder="Search by name or slug…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {SUSPENSION_CHIPS.map((chip) => (
          <Button
            key={chip.key}
            type="button"
            variant={suspensionFilter === chip.key ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setSuspensionFilter(chip.key)}
            className={cn(suspensionFilter === chip.key && 'ring-1 ring-inset ring-ring')}
          >
            {chip.label}
          </Button>
        ))}
        {planOptions.length > 0 && <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />}
        <Button
          type="button"
          variant={planKeyFilter === undefined ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => setPlanKeyFilter(undefined)}
          className={cn(planKeyFilter === undefined && 'ring-1 ring-inset ring-ring')}
        >
          All plans
        </Button>
        {planOptions.map(([key, label]) => (
          <Button
            key={key}
            type="button"
            variant={planKeyFilter === key ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setPlanKeyFilter(key)}
            className={cn(planKeyFilter === key && 'ring-1 ring-inset ring-ring')}
          >
            {label}
          </Button>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          {query.isPending ? (
            <SkeletonTable rows={8} cols={6} />
          ) : query.isError ? (
            <p className="p-6 text-sm text-destructive">Failed to load orgs.</p>
          ) : orgs.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No orgs match this filter.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Org</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Seats</TableHead>
                    <TableHead>Projects</TableHead>
                    <TableHead>Overage policy</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orgs.map((org) => (
                    <TableRow key={org.id} className="cursor-pointer">
                      <TableCell>
                        <Link to={`/orgs/${org.id}`} className="hover:underline">
                          <div className="font-medium text-foreground">{org.name}</div>
                          <div className="text-xs text-muted-foreground">{org.slug}</div>
                        </Link>
                      </TableCell>
                      <TableCell>{org.planName ?? '—'}</TableCell>
                      <TableCell>{org.seatCount}</TableCell>
                      <TableCell>{org.projectCount}</TableCell>
                      <TableCell className="capitalize">{org.overagePolicy}</TableCell>
                      <TableCell>
                        {org.suspendedAt ? (
                          <Badge variant="destructive">Suspended</Badge>
                        ) : (
                          <Badge variant="outline">Active</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {query.data?.nextCursor ? (
        <p className="text-center text-xs text-muted-foreground">
          More orgs exist beyond this page — narrow your search to find a specific one.
        </p>
      ) : null}
    </div>
  )
}
