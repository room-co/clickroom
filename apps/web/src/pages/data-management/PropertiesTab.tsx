import { Lock, Search } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { trpc } from '@/lib/trpc'
import { useAuth } from '@/lib/use-auth'
import { cn } from '@/lib/utils'
import { formatLastSeen } from './format'
import { PropertyEditDialog } from './PropertyEditDialog'
import { TableEmpty, TableError, TableLoading } from './states'
import type { PropertyScope, SerializedProperty } from './types'

export function PropertiesTab({ projectId }: { projectId: string | undefined }) {
  const { can } = useAuth()
  const canManageProjects = can('projects:manage')
  const [scope, setScope] = useState<PropertyScope>('event')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<SerializedProperty | null>(null)

  const query = trpc.taxonomy.properties.list.useQuery(
    {
      projectId: projectId ?? '',
      scope,
      search: search.trim() || undefined,
    },
    { enabled: !!projectId },
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search properties…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <Select value={scope} onValueChange={(v) => setScope(v as PropertyScope)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="event">Event properties</SelectItem>
            <SelectItem value="person">Person properties</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border">
        {query.isPending ? (
          <TableLoading />
        ) : query.isError ? (
          <TableError message={query.error.message} />
        ) : query.data.length === 0 ? (
          <TableEmpty
            message={
              search
                ? 'No properties match your search.'
                : 'Properties appear here as events are ingested.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.map((property) => (
                  <TableRow
                    key={property.id}
                    className={cn(canManageProjects && 'cursor-pointer')}
                    onClick={canManageProjects ? () => setEditing(property) : undefined}
                  >
                    <TableCell>
                      <span className="font-mono text-xs">{property.name}</span>
                      {property.description ? (
                        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                          {property.description}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="secondary" className="text-[10px]">
                          {property.propertyType}
                        </Badge>
                        {property.typeLocked ? (
                          <Lock className="size-3 text-muted-foreground" aria-label="Type locked" />
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {property.verified ? <Badge className="text-[10px]">verified</Badge> : null}
                        {property.hidden ? (
                          <Badge variant="outline" className="text-[10px]">
                            hidden
                          </Badge>
                        ) : null}
                        {!property.verified && !property.hidden ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatLastSeen(property.lastSeenAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {projectId && canManageProjects ? (
        <PropertyEditDialog
          projectId={projectId}
          scope={scope}
          property={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  )
}
