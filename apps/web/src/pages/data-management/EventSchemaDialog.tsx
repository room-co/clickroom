import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { SkeletonTable } from '@/components/skeletons'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { trpc } from '@/lib/trpc'
import {
  nextRowKey,
  type PropertyRow,
  PropertyRowsEditor,
  validateRows,
} from './PropertyRowsEditor'
import type { SerializedEvent } from './types'

type EventSchemaDialogProps = {
  projectId: string
  event: SerializedEvent | null
  onClose: () => void
}

export function EventSchemaDialog({ projectId, event, onClose }: EventSchemaDialogProps) {
  const utils = trpc.useUtils()
  const [rows, setRows] = useState<PropertyRow[]>([])

  const propertiesQuery = trpc.taxonomy.properties.list.useQuery(
    { projectId, scope: 'event', eventName: event?.name },
    { enabled: !!event },
  )

  // Only re-seed when the target event changes or its property list loads — not
  // on every query refetch, which would clobber in-progress edits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on event?.id, not the whole event object
  useEffect(() => {
    if (event && propertiesQuery.data) {
      setRows(
        propertiesQuery.data.map((p) => ({
          key: nextRowKey(),
          name: p.name,
          type: p.propertyType,
          required: p.required ?? false,
        })),
      )
    }
    if (!event) {
      setRows([])
    }
  }, [event?.id, propertiesQuery.data])

  const setSchema = trpc.taxonomy.events.setSchema.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.taxonomy.properties.list.invalidate(),
        utils.taxonomy.events.list.invalidate(),
      ])
      toast.success('Schema saved')
      onClose()
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to save schema')
    },
  })

  const { hasBlankName, hasDuplicate } = validateRows(rows)

  function handleSave() {
    if (!event || hasBlankName || hasDuplicate) return
    setSchema.mutate({
      projectId,
      event: event.name,
      properties: rows.map((r) => ({
        name: r.name.trim(),
        type: r.type,
        required: r.required,
      })),
    })
  }

  return (
    <Dialog open={!!event} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit schema</DialogTitle>
          <DialogDescription>
            {event ? (
              <span className="font-mono text-xs">{event.name}</span>
            ) : (
              'Declare the properties expected on this event.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          {propertiesQuery.isPending ? (
            <SkeletonTable rows={3} cols={4} header={false} className="p-0" />
          ) : (
            <PropertyRowsEditor rows={rows} onChange={setRows} />
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={setSchema.isPending}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={setSchema.isPending || hasBlankName || hasDuplicate}
          >
            {setSchema.isPending ? 'Saving…' : 'Save schema'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
