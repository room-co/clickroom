// Renders segment_get (criteria) / segment_preview_count (live count) tool
// output. These are two different tRPC shapes (segment_get returns the full
// Segment row incl. rule definition; segment_preview_count returns only
// `{count, scanDays}`, it does not echo the definition it scanned) — so two
// small widgets share this file rather than one component guessing at a
// shape neither tool alone provides.
import { Users } from 'lucide-react'
import { formatNumber } from '@/lib/format'

type SegmentOperator = 'exact' | 'is_not' | 'icontains' | 'gt' | 'lt' | 'is_set'

type SegmentCondition =
  | { type: 'trait'; key: string; operator: SegmentOperator; value?: unknown }
  | {
      type: 'event_property'
      key: string
      operator: SegmentOperator
      value?: unknown
      event?: string
    }
  | { type: 'behavioral'; event: string; count: number; days: number }

interface SegmentGroup {
  combinator: 'AND' | 'OR'
  conditions: (SegmentCondition | SegmentGroup)[]
}

export interface SegmentData {
  id: string
  name: string
  description: string | null
  definition: { version: 1; root: SegmentGroup } | null
}

const OPERATOR_LABELS: Record<SegmentOperator, string> = {
  exact: 'equals',
  is_not: 'is not',
  icontains: 'contains',
  gt: 'greater than',
  lt: 'less than',
  is_set: 'is set',
}

function isGroup(node: SegmentCondition | SegmentGroup): node is SegmentGroup {
  return 'combinator' in node
}

function describeCondition(node: SegmentCondition): string {
  switch (node.type) {
    case 'trait':
      return `trait "${node.key}" ${OPERATOR_LABELS[node.operator]}${
        node.operator === 'is_set' ? '' : ` ${JSON.stringify(node.value)}`
      }`
    case 'event_property':
      return `${node.event ? `${node.event}.` : ''}"${node.key}" ${OPERATOR_LABELS[node.operator]}${
        node.operator === 'is_set' ? '' : ` ${JSON.stringify(node.value)}`
      }`
    case 'behavioral':
      return `did "${node.event}" ${node.count}+ times in the last ${node.days}d`
  }
}

function ConditionGroup({ group, depth = 0 }: { group: SegmentGroup; depth?: number }) {
  return (
    <div className={depth > 0 ? 'ml-3 border-l border-border/60 pl-3' : undefined}>
      {group.conditions.map((node, i) => (
        <div key={isGroup(node) ? `g${i}` : `${node.type}-${i}`} className="py-0.5">
          {i > 0 && (
            <span className="mr-1.5 font-mono text-[10px] uppercase text-muted-foreground">
              {group.combinator}
            </span>
          )}
          {isGroup(node) ? (
            <ConditionGroup group={node} depth={depth + 1} />
          ) : (
            <span className="text-xs text-foreground">{describeCondition(node)}</span>
          )}
        </div>
      ))}
    </div>
  )
}

export function SegmentDetailWidget({ segment }: { segment: SegmentData }) {
  return (
    <div className="w-full min-w-0 rounded-lg border border-border bg-card p-4">
      <div className="text-sm font-medium text-foreground">{segment.name}</div>
      {segment.description && (
        <div className="mt-1 text-[11px] text-muted-foreground">{segment.description}</div>
      )}
      <div className="mt-3 border-t border-border pt-2">
        {segment.definition ? (
          <ConditionGroup group={segment.definition.root} />
        ) : (
          <span className="text-xs text-muted-foreground">No criteria defined.</span>
        )}
      </div>
    </div>
  )
}

export function SegmentCountWidget({ count, scanDays }: { count: number; scanDays: number }) {
  return (
    <div className="flex w-full min-w-0 max-w-xs items-center gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
        <Users className="h-4 w-4 text-primary" />
      </div>
      <div>
        <div className="font-mono text-xl font-semibold text-foreground">{formatNumber(count)}</div>
        <div className="text-[10px] text-muted-foreground">members · last {scanDays}d scanned</div>
      </div>
    </div>
  )
}
