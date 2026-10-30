import { SkeletonTable } from '@/components/skeletons'
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

const SEVERITY_DOT_CLASS: Record<'high' | 'medium' | 'low', string> = {
  high: 'bg-tone-destructive',
  medium: 'bg-tone-billing',
  low: 'bg-tone-routine',
}

/** Audit tab: this org's slice of the global audit log (`admin.audit.list` filtered by
 * `targetOrgId`), distinct from the global `/audit` page. */
export function AuditTab({ orgId }: { orgId: string }) {
  const query = trpc.admin.audit.list.useQuery({ targetOrgId: orgId, limit: 50 })

  if (query.isPending) {
    return <SkeletonTable rows={6} cols={3} />
  }
  if (query.isError) {
    return <p className="p-4 text-sm text-destructive">Failed to load audit log.</p>
  }
  if (query.data.items.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No audit entries for this org yet.</p>
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Severity</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Admin</TableHead>
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
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                {formatTimestamp(item.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
