import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { PropertyType } from './types'

export const PROPERTY_TYPES: PropertyType[] = ['String', 'Numeric', 'Boolean', 'DateTime']

export type PropertyRow = {
  // Client-side identity for React keys — stable across renders even if the
  // property name is being edited (unlike using `name` as the key).
  key: string
  name: string
  type: PropertyType
  required: boolean
}

let rowSeq = 0
export const nextRowKey = () => {
  rowSeq += 1
  return `row-${rowSeq}`
}

export function emptyRow(): PropertyRow {
  return { key: nextRowKey(), name: '', type: 'String', required: false }
}

/** Shared validation used before both create-with-schema and edit-schema saves. */
export function validateRows(rows: PropertyRow[]): {
  hasBlankName: boolean
  hasDuplicate: boolean
} {
  const hasBlankName = rows.some((r) => r.name.trim() === '')
  const names = rows.map((r) => r.name.trim().toLowerCase()).filter(Boolean)
  const hasDuplicate = new Set(names).size !== names.length
  return { hasBlankName, hasDuplicate }
}

type PropertyRowsEditorProps = {
  rows: PropertyRow[]
  onChange: (rows: PropertyRow[]) => void
  emptyMessage?: string
}

/** Add/edit/remove UI for a list of declared event properties (name/type/required).
 * Shared between `EventSchemaDialog` (editing an existing event's schema) and
 * `AddEventDialog` (optionally declaring properties at creation time). */
export function PropertyRowsEditor({
  rows,
  onChange,
  emptyMessage = 'No properties declared yet. Add one below.',
}: PropertyRowsEditorProps) {
  function addRow() {
    onChange([...rows, emptyRow()])
  }

  function removeRow(key: string) {
    onChange(rows.filter((r) => r.key !== key))
  }

  function updateRow(key: string, patch: Partial<PropertyRow>) {
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  const { hasBlankName, hasDuplicate } = validateRows(rows)

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyMessage}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <div
              key={row.key}
              className="grid grid-cols-1 items-start gap-2 rounded-md border p-2.5 sm:grid-cols-[1fr_130px_auto_auto] sm:items-center"
            >
              <Input
                placeholder="property_name"
                value={row.name}
                onChange={(e) => updateRow(row.key, { name: e.target.value })}
                className="font-mono text-xs"
              />
              <Select
                value={row.type}
                onValueChange={(v) => updateRow(row.key, { type: v as PropertyType })}
              >
                <SelectTrigger className="w-full sm:w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROPERTY_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`required-${row.key}`}
                  checked={row.required}
                  onCheckedChange={(checked) => updateRow(row.key, { required: !!checked })}
                />
                <Label htmlFor={`required-${row.key}`} className="text-xs font-normal">
                  Required
                </Label>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="justify-self-end text-muted-foreground hover:text-destructive"
                onClick={() => removeRow(row.key)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {hasBlankName && <p className="text-xs text-destructive">Property names cannot be empty.</p>}
      {hasDuplicate && <p className="text-xs text-destructive">Property names must be unique.</p>}

      <Button variant="outline" size="sm" onClick={addRow} className="w-fit">
        <Plus className="size-3.5" />
        Add property
      </Button>
    </div>
  )
}
