// Renders analytics_live tool output — recent raw events, newest first.
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatTimestamp } from '@/lib/format'

export interface LiveFeedEvent {
  uuid: string
  event: string
  distinct_id: string
  timestamp: string
  current_url: string
}

function truncate(value: string, max = 40): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export function LiveFeedWidget({ events }: { events: LiveFeedEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="w-full min-w-0 rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
        No recent events.
      </div>
    )
  }
  return (
    <div className="w-full min-w-0 overflow-x-auto rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Event
            </TableHead>
            <TableHead className="text-[10px] uppercase tracking-wider text-muted-foreground">
              User
            </TableHead>
            <TableHead className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Page
            </TableHead>
            <TableHead className="text-right text-[10px] uppercase tracking-wider text-muted-foreground">
              Time
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((e) => (
            <TableRow key={e.uuid}>
              <TableCell className="font-mono text-xs text-foreground">{e.event}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {truncate(e.distinct_id, 20)}
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {truncate(e.current_url)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-muted-foreground">
                {formatTimestamp(e.timestamp)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
