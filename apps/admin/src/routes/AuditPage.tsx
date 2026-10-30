import { keepPreviousData } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { SkeletonTable } from '@/components/skeletons'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatTimestamp } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { cn } from '@/lib/utils'

// Mirrors `AuditCategory` from `packages/db/src/admin-audit/classify-audit-action.ts` — kept as
// a local literal union rather than a `@clickroom/db` dependency, since apps/admin otherwise
// only depends on `@clickroom/trpc-router` and this type isn't re-exported from there.
type AuditCategory = 'destructive' | 'billing' | 'impersonation' | 'routine'

const CATEGORY_CHIPS: { key: AuditCategory | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'destructive', label: 'Destructive' },
  { key: 'billing', label: 'Billing' },
  { key: 'impersonation', label: 'Impersonation' },
  { key: 'routine', label: 'Routine' },
]

const SEVERITY_DOT_CLASS: Record<'high' | 'medium' | 'low', string> = {
  high: 'bg-tone-destructive',
  medium: 'bg-tone-billing',
  low: 'bg-tone-routine',
}

/**
 * `/audit`. Global `admin.audit.list`, category-filterable with severity dots
 * (high=destructive/impersonation, medium=billing, low=routine — matches the router's own
 * `SEVERITY_BY_CATEGORY`). Cursor-paginated server-side; `keepPreviousData` so switching the
 * category filter doesn't collapse loaded rows back to a skeleton.
 */
export function AuditPage() {
  const [category, setCategory] = useState<AuditCategory | 'all'>('all')
  const [cursor, setCursor] = useState<string | undefined>(undefined)

  const query = trpc.admin.audit.list.useQuery(
    { category: category === 'all' ? undefined : category, cursor, limit: 25 },
    { placeholderData: keepPreviousData },
  )

  function onCategoryChange(next: AuditCategory | 'all') {
    setCategory(next)
    setCursor(undefined)
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Audit log</h1>
        <p className="text-sm text-muted-foreground">Every admin-console mutation, attributed.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {CATEGORY_CHIPS.map((chip) => (
          <Button
            key={chip.key}
            type="button"
            variant={category === chip.key ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => onCategoryChange(chip.key)}
            className={cn(category === chip.key && 'ring-1 ring-inset ring-ring')}
          >
            {chip.label}
          </Button>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          {query.isPending ? (
            <SkeletonTable rows={10} cols={5} />
          ) : query.isError ? (
            <p className="p-6 text-sm text-destructive">Failed to load audit log.</p>
          ) : query.data.items.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No audit entries for this filter.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Severity</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Admin</TableHead>
                    <TableHead>Org</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <span
                          role="img"
                          className={cn(
                            'inline-block size-2 rounded-full',
                            SEVERITY_DOT_CLASS[item.severity],
                          )}
                          title={item.severity}
                          aria-label={`${item.severity} severity`}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{item.action}</TableCell>
                      <TableCell>{item.adminUser.email}</TableCell>
                      <TableCell>
                        {item.targetOrg ? (
                          <Link to={`/orgs/${item.targetOrg.id}`} className="hover:underline">
                            {item.targetOrg.name}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatTimestamp(item.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-center">
        {query.data?.nextCursor ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => setCursor(query.data?.nextCursor ?? undefined)}
            disabled={query.isFetching}
          >
            {query.isFetching ? 'Loading…' : 'Load more'}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
