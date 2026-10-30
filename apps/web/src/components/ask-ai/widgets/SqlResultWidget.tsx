// Renders sql_query tool output. Reuses sql-explorer's QueryChart when the
// result looks chartable (2+ columns, at least one numeric); otherwise falls
// back to the shared Table primitives for a plain tabular view.
import { useState } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatNumber } from '@/lib/format'
import { QueryChart, type VizConfig } from '@/pages/sql-explorer/QueryChart'

export interface SqlResultColumn {
  name: string
  type: string
}

export interface SqlResultData {
  columns: SqlResultColumn[]
  rows: unknown[][]
  rowCount: number
  elapsedMs: number
}

const NUMERIC_TYPE_PREFIXES = ['UInt', 'Int', 'Float', 'Decimal']

function isNumericType(type: string): boolean {
  return NUMERIC_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix))
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function SqlTable({ data }: { data: SqlResultData }) {
  return (
    <div className="w-full min-w-0 overflow-x-auto rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            {data.columns.map((col) => (
              <TableHead
                key={col.name}
                className="whitespace-nowrap text-[10px] uppercase tracking-wider text-muted-foreground"
              >
                {col.name}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((row, rowIdx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: SQL rows have no stable id
            <TableRow key={rowIdx}>
              {row.map((cell, cellIdx) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: SQL cells have no stable id
                <TableCell key={cellIdx} className="whitespace-nowrap font-mono text-xs">
                  {cellToString(cell)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function SqlResultWidget({ data }: { data: SqlResultData }) {
  const [config, setConfig] = useState<VizConfig | null>(null)
  const chartable = data.columns.length >= 2 && data.columns.some((c) => isNumericType(c.type))

  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      {data.rows.length > 0 && chartable ? (
        <div className="h-72 w-full min-w-0 rounded-lg border border-border bg-card">
          <QueryChart
            columns={data.columns}
            rows={data.rows}
            config={config}
            onConfigChange={setConfig}
          />
        </div>
      ) : (
        <SqlTable data={data} />
      )}
      <div className="text-[10px] text-muted-foreground">
        {formatNumber(data.rowCount)} rows · {data.elapsedMs}ms
      </div>
    </div>
  )
}
