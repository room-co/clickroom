import { Plus, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { AddEventDialog } from './AddEventDialog'
import { EventSchemaDialog } from './EventSchemaDialog'
import { ENFORCEMENT_OPTIONS } from './enforcement'
import { formatVolume } from './format'
import { TableEmpty, TableError, TableLoading } from './states'
import type { EnforcementMode, SerializedEvent } from './types'

const ENFORCEMENT_LABEL: Record<EnforcementMode, string> = Object.fromEntries(
  ENFORCEMENT_OPTIONS.map((o) => [o.value, o.label]),
) as Record<EnforcementMode, string>

/** Inline enforcement-mode select for one event row — mutates on change.
 * Viewers can't call `taxonomy.events.update` server-side, so they get a
 * read-only label instead of the select. */
function EnforcementSelect({ projectId, event }: { projectId: string; event: SerializedEvent }) {
  const { can } = useAuth()
  const utils = trpc.useUtils()
  const update = trpc.taxonomy.events.update.useMutation({
    onSuccess: async () => {
      await utils.taxonomy.events.list.invalidate()
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to update enforcement mode')
    },
  })

  if (!can('projects:manage')) {
    return (
      <span className="text-xs text-muted-foreground">
        {ENFORCEMENT_LABEL[event.enforcementMode]}
      </span>
    )
  }

  return (
    <Select
      value={event.enforcementMode}
      onValueChange={(v) =>
        update.mutate({ projectId, id: event.id, enforcementMode: v as EnforcementMode })
      }
    >
      <SelectTrigger className="h-8 w-28 text-xs" disabled={update.isPending}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ENFORCEMENT_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function SchemaTab({ projectId }: { projectId: string | undefined }) {
  const { can } = useAuth()
  const canManageProjects = can('projects:manage')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<SerializedEvent | null>(null)
  const [adding, setAdding] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()

  // Cross-page deep link (e.g. from the Events page's "Add Event" button):
  // `?tab=schema&create=1` opens this dialog on landing. Clear the param
  // immediately after so a refresh doesn't reopen it.
  // Only react to the `create` param itself, not every search-param change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on the create param only
  useEffect(() => {
    if (searchParams.get('create') === '1') {
      if (canManageProjects) setAdding(true)
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.delete('create')
          return next
        },
        { replace: true },
      )
    }
  }, [searchParams.get('create')])

  const query = trpc.taxonomy.events.list.useQuery(
    { projectId: projectId ?? '', search: search.trim() || undefined },
    { enabled: !!projectId },
  )

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-auto p-5">
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
        <p className="text-xs text-muted-foreground sm:max-w-xs">
          Declare required properties per event and enforce a strict/warn schema at ingest.
        </p>
        {canManageProjects && (
          <Button size="sm" onClick={() => setAdding(true)} disabled={!projectId}>
            <Plus className="size-3.5" />
            Add event
          </Button>
        )}
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
                  <TableHead>Enforcement</TableHead>
                  <TableHead className="text-right">Volume (30d)</TableHead>
                  <TableHead className="text-right">Schema</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.map((event) =>
                  projectId ? (
                    <TableRow key={event.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs">{event.name}</span>
                          {event.isSystem ? (
                            <Badge variant="secondary" className="text-[10px]">
                              system
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <EnforcementSelect projectId={projectId} event={event} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatVolume(event.volume30d)}
                      </TableCell>
                      <TableCell className="text-right">
                        {canManageProjects ? (
                          <Button variant="outline" size="sm" onClick={() => setEditing(event)}>
                            Edit schema
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ) : null,
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {projectId ? (
        <>
          <EventSchemaDialog
            projectId={projectId}
            event={editing}
            onClose={() => setEditing(null)}
          />
          <AddEventDialog projectId={projectId} open={adding} onClose={() => setAdding(false)} />
        </>
      ) : null}
    </div>
  )
}
