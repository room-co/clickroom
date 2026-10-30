import { useState } from 'react'
import { SkeletonTable } from '@/components/skeletons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { ConfirmActionDialog } from './ConfirmActionDialog'

// tRPC has no superjson transformer on the admin routers (see admin-orgs.router.ts's own doc
// comment) — Date fields arrive over the wire as ISO strings, not `Date` instances, even though
// the server-side return type says `Date`. `formatTimestamp` accepts both.
interface OrgDetail {
  id: string
  name: string
  slug: string
  planName: string | null
  memberCount: number
  projectCount: number
  suspendedAt: string | null
  suspensionReason: string | null
  createdAt: string
}

/** Overview tab: org summary, suspend/unsuspend, and its projects + API-key metadata. */
export function OverviewTab({ org }: { org: OrgDetail }) {
  const utils = trpc.useUtils()
  const invalidate = () => {
    void utils.admin.orgs.get.invalidate({ orgId: org.id })
    void utils.admin.orgs.list.invalidate()
  }
  const suspendOrg = trpc.admin.orgs.suspendOrg.useMutation({ onSuccess: invalidate })
  const unsuspendOrg = trpc.admin.orgs.unsuspendOrg.useMutation({ onSuccess: invalidate })
  const [suspendReason, setSuspendReason] = useState('')

  const projectsQuery = trpc.admin.orgs.listProjects.useQuery({ orgId: org.id })
  const apiKeysQuery = trpc.admin.orgs.listApiKeys.useQuery({ orgId: org.id })

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span>Summary</span>
            {org.suspendedAt ? (
              <ConfirmActionDialog
                trigger={
                  <Button type="button" variant="outline">
                    Unsuspend org
                  </Button>
                }
                title="Unsuspend org"
                description={`Restore access for ${org.name}?`}
                confirmLabel="Unsuspend"
                onConfirm={() => unsuspendOrg.mutateAsync({ orgId: org.id })}
              />
            ) : (
              <ConfirmActionDialog
                trigger={
                  <Button type="button" variant="destructive">
                    Suspend org
                  </Button>
                }
                title="Suspend org"
                description={
                  <div className="flex flex-col gap-2 text-left">
                    <p>
                      Every org-scoped request from {org.name} will be rejected until unsuspended. A
                      reason is required.
                    </p>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="suspend-reason">Reason</Label>
                      <Input
                        id="suspend-reason"
                        value={suspendReason}
                        onChange={(event) => setSuspendReason(event.target.value)}
                        placeholder="e.g. Chargeback / ToS violation"
                      />
                    </div>
                  </div>
                }
                confirmLabel="Suspend"
                destructive
                onConfirm={() =>
                  suspendOrg.mutateAsync({ orgId: org.id, reason: suspendReason.trim() })
                }
              />
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <SummaryField label="Slug" value={org.slug} />
          <SummaryField label="Plan" value={org.planName ?? '—'} />
          <SummaryField label="Members" value={String(org.memberCount)} />
          <SummaryField label="Projects" value={String(org.projectCount)} />
          <SummaryField label="Created" value={formatTimestamp(org.createdAt)} />
          <SummaryField
            label="Status"
            value={
              org.suspendedAt ? (
                <Badge variant="destructive">
                  Suspended{org.suspensionReason ? `: ${org.suspensionReason}` : ''}
                </Badge>
              ) : (
                <Badge variant="outline">Active</Badge>
              )
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Projects</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {projectsQuery.isPending ? (
            <SkeletonTable rows={3} cols={3} />
          ) : projectsQuery.isError ? (
            <p className="p-4 text-sm text-destructive">Failed to load projects.</p>
          ) : projectsQuery.data.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No projects.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Domain</TableHead>
                    <TableHead>Retention (days)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projectsQuery.data.map((project) => (
                    <TableRow key={project.id}>
                      <TableCell>{project.name}</TableCell>
                      <TableCell>{project.domain ?? '—'}</TableCell>
                      <TableCell>{project.dataRetentionDays}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">API keys</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {apiKeysQuery.isPending ? (
            <SkeletonTable rows={3} cols={4} />
          ) : apiKeysQuery.isError ? (
            <p className="p-4 text-sm text-destructive">Failed to load API keys.</p>
          ) : apiKeysQuery.data.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No API keys.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead>
                    <TableHead>Project</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Last used</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {apiKeysQuery.data.map((key) => (
                    <TableRow key={key.id}>
                      <TableCell>
                        <span className="font-mono text-xs">{key.keyPrefix}…</span>
                        {key.label ? (
                          <span className="ml-2 text-xs text-muted-foreground">{key.label}</span>
                        ) : null}
                      </TableCell>
                      <TableCell>{key.projectName ?? '—'}</TableCell>
                      <TableCell className="capitalize">{key.type}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {key.lastUsedAt ? formatTimestamp(key.lastUsedAt) : 'Never'}
                      </TableCell>
                      <TableCell>
                        {key.revokedAt ? (
                          <Badge variant="destructive">Revoked</Badge>
                        ) : key.expiresAt && new Date(key.expiresAt).getTime() < Date.now() ? (
                          <Badge variant="secondary">Expired</Badge>
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
    </div>
  )
}

function SummaryField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-foreground">{value}</span>
    </div>
  )
}
