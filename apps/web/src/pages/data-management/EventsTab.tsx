import { Search } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
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
import { EventEditDialog } from './EventEditDialog'
import { formatLastSeen, formatVolume } from './format'
import { TableEmpty, TableError, TableLoading } from './states'
import type { SerializedEvent } from './types'

export function EventsTab({ projectId }: { projectId: string | undefined }) {
  const { can } = useAuth()
  const canManageProjects = can('projects:manage')
  const [search, setSearch] = useState('')
  const [includeHidden, setIncludeHidden] = useState(false)
  const [editing, setEditing] = useState<SerializedEvent | null>(null)

  const query = trpc.taxonomy.events.list.useQuery(
    {
      projectId: projectId ?? '',
      search: search.trim() || undefined,
      includeHidden,
    },
    { enabled: !!projectId },
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search events…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch id="events-hidden" checked={includeHidden} onCheckedChange={setIncludeHidden} />
          <Label htmlFor="events-hidden" className="text-sm text-muted-foreground">
            Show hidden
          </Label>
        </div>
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
                ? 'No events match your search.'
                : 'Events appear here once your project starts receiving data.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Volume (30d)</TableHead>
                  <TableHead>Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.map((event) => (
                  <TableRow
                    key={event.id}
                    className={cn(canManageProjects && 'cursor-pointer')}
                    onClick={canManageProjects ? () => setEditing(event) : undefined}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{event.name}</span>
                        {event.isSystem ? (
                          <Badge variant="secondary" className="text-[10px]">
                            system
                          </Badge>
                        ) : null}
                      </div>
                      {event.description ? (
                        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                          {event.description}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {event.verified ? <Badge className="text-[10px]">verified</Badge> : null}
                        {event.hidden ? (
                          <Badge variant="outline" className="text-[10px]">
                            hidden
                          </Badge>
                        ) : null}
                        {!event.verified && !event.hidden ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatVolume(event.volume30d)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatLastSeen(event.lastSeenAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {projectId && canManageProjects ? (
        <EventEditDialog projectId={projectId} event={editing} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  )
}
