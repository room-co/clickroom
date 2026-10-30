// Renders user_detail / user_sessions / user_activity tool output. None of
// these outputs include the distinct_id itself (it's a tool *input*, not
// echoed back), so the widget titles stay generic rather than guessing at an
// identity label.
import type { ReactNode } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDate, formatNumber, formatTimestamp } from '@/lib/format'

export interface UserEventRow {
  uuid: string
  event: string
  timestamp: string
  current_url: string
}

export interface UserSessionRow {
  sessionId: string
  startedAt: string
  endedAt: string
  durationSec: number
  events: number
  pages: number
  entryUrl: string
  exitUrl: string
}

export interface UserActivityBucket {
  bucket: string
  count: number
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m ${seconds % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function CardShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="w-full min-w-0 overflow-x-auto rounded-lg border border-border bg-card">
      <div className="border-b border-border px-3 py-2 text-xs font-medium text-foreground">
        {title}
      </div>
      {children}
    </div>
  )
}

export function UserEventsWidget({ events }: { events: UserEventRow[] }) {
  if (events.length === 0) {
    return (
      <CardShell title="Recent activity">
        <div className="p-4 text-xs text-muted-foreground">No events found.</div>
      </CardShell>
    )
  }
  return (
    <CardShell title="Recent activity">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Event
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
              <TableCell className="max-w-[200px] truncate font-mono text-xs text-muted-foreground">
                {e.current_url}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-muted-foreground">
                {formatTimestamp(e.timestamp)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardShell>
  )
}

export function UserSessionsWidget({ sessions }: { sessions: UserSessionRow[] }) {
  if (sessions.length === 0) {
    return (
      <CardShell title="Sessions">
        <div className="p-4 text-xs text-muted-foreground">No sessions found.</div>
      </CardShell>
    )
  }
  return (
    <CardShell title="Sessions">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Started
            </TableHead>
            <TableHead className="text-right text-[10px] uppercase tracking-wider text-muted-foreground">
              Duration
            </TableHead>
            <TableHead className="text-right text-[10px] uppercase tracking-wider text-muted-foreground">
              Events
            </TableHead>
            <TableHead className="text-right text-[10px] uppercase tracking-wider text-muted-foreground">
              Pages
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((s) => (
            <TableRow key={s.sessionId}>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {formatTimestamp(s.startedAt)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-foreground">
                {formatDuration(s.durationSec)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-foreground">
                {formatNumber(s.events)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-foreground">
                {formatNumber(s.pages)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardShell>
  )
}

export function UserActivityWidget({ activity }: { activity: UserActivityBucket[] }) {
  if (activity.length === 0) {
    return (
      <CardShell title="Activity (last 7 days)">
        <div className="p-4 text-xs text-muted-foreground">No activity found.</div>
      </CardShell>
    )
  }
  const max = Math.max(1, ...activity.map((a) => a.count))
  return (
    <CardShell title="Activity (last 7 days)">
      <div className="flex flex-col gap-1.5 p-3">
        {activity.map((a) => (
          <div key={a.bucket} className="flex items-center gap-2">
            <span className="w-16 shrink-0 font-mono text-[10px] text-muted-foreground">
              {formatDate(a.bucket)}
            </span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${(a.count / max) * 100}%` }}
              />
            </div>
            <span className="w-10 shrink-0 text-right font-mono text-[10px] text-foreground">
              {formatNumber(a.count)}
            </span>
          </div>
        ))}
      </div>
    </CardShell>
  )
}
