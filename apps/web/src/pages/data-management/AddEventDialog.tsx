import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { trpc } from '@/lib/trpc'
import { ENFORCEMENT_OPTIONS } from './enforcement'
import { type PropertyRow, PropertyRowsEditor, validateRows } from './PropertyRowsEditor'
import type { EnforcementMode } from './types'

type AddEventDialogProps = {
  projectId: string
  open: boolean
  onClose: () => void
}

/** Pre-declare a brand-new event's schema before any real traffic for it has
 * arrived — creates an `EventDefinition` (via `events.create`, which upserts
 * so it safely coexists with auto-discovery) and, if any properties were
 * declared, immediately follows up with `events.setSchema`. */
export function AddEventDialog({ projectId, open, onClose }: AddEventDialogProps) {
  const utils = trpc.useUtils()
  const [name, setName] = useState('')
  const [enforcementMode, setEnforcementMode] = useState<EnforcementMode>('none')
  const [rows, setRows] = useState<PropertyRow[]>([])
  const [saving, setSaving] = useState(false)

  // Reset form state whenever the dialog opens fresh.
  useEffect(() => {
    if (open) {
      setName('')
      setEnforcementMode('none')
      setRows([])
    }
  }, [open])

  // Client-side pre-check against the cached event list so we can warn before
  // the user hits submit — the backend upsert remains the authoritative check
  // (e.g. if another tab/user created the same name concurrently).
  const eventsQuery = trpc.taxonomy.events.list.useQuery(
    { projectId, includeHidden: true },
    { enabled: open },
  )
  const existingNames = new Set((eventsQuery.data ?? []).map((e) => e.name.toLowerCase()))

  const trimmedName = name.trim()
  const hasBlankName = trimmedName === ''
  const hasCollision = !hasBlankName && existingNames.has(trimmedName.toLowerCase())
  const { hasBlankName: rowsHaveBlankName, hasDuplicate: rowsHaveDuplicate } = validateRows(rows)

  const canSave =
    !hasBlankName && !hasCollision && !rowsHaveBlankName && !rowsHaveDuplicate && !saving

  const createEvent = trpc.taxonomy.events.create.useMutation()
  const setSchema = trpc.taxonomy.events.setSchema.useMutation()

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    try {
      await createEvent.mutateAsync({ projectId, name: trimmedName, enforcementMode })
      if (rows.length > 0) {
        await setSchema.mutateAsync({
          projectId,
          event: trimmedName,
          properties: rows.map((r) => ({
            name: r.name.trim(),
            type: r.type,
            required: r.required,
          })),
        })
      }
      await Promise.all([
        utils.taxonomy.events.list.invalidate(),
        utils.taxonomy.properties.list.invalidate(),
      ])
      toast.success('Event created')
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create event')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add event</DialogTitle>
          <DialogDescription>
            Declare a new event's contract before any traffic for it arrives.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-event-name" className="text-xs">
              Event name
            </Label>
            <Input
              id="new-event-name"
              placeholder="e.g. checkout_completed"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="font-mono text-xs"
              autoFocus
            />
            {hasCollision && (
              <p className="text-xs text-destructive">
                An event named "{trimmedName}" already exists.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Enforcement</Label>
            <Select
              value={enforcementMode}
              onValueChange={(v) => setEnforcementMode(v as EnforcementMode)}
            >
              <SelectTrigger className="w-40 text-xs">
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
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Properties (optional)</Label>
            <PropertyRowsEditor
              rows={rows}
              onChange={setRows}
              emptyMessage="No properties declared yet — you can add them later from the Schema tab."
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving ? 'Creating…' : 'Create event'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
