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
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc'
import type { SerializedEvent } from './types'

type EventEditDialogProps = {
  projectId: string
  event: SerializedEvent | null
  onClose: () => void
}

export function EventEditDialog({ projectId, event, onClose }: EventEditDialogProps) {
  const utils = trpc.useUtils()
  const [description, setDescription] = useState('')
  const [verified, setVerified] = useState(false)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    if (event) {
      setDescription(event.description ?? '')
      setVerified(event.verified)
      setHidden(event.hidden)
    }
  }, [event])

  const update = trpc.taxonomy.events.update.useMutation({
    onSuccess: async () => {
      await utils.taxonomy.events.list.invalidate()
      toast.success('Event updated')
      onClose()
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to update event')
    },
  })

  function handleSave() {
    if (!event) return
    update.mutate({
      projectId,
      id: event.id,
      description: description.trim() === '' ? null : description.trim(),
      verified,
      hidden,
    })
  }

  return (
    <Dialog open={!!event} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit event</DialogTitle>
          <DialogDescription>
            {event ? (
              <span className="font-mono text-xs">{event.name}</span>
            ) : (
              'Update the definition for this event.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="event-description">Description</Label>
            <Textarea
              id="event-description"
              placeholder="Describe what this event represents…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="event-verified">Verified</Label>
              <span className="text-xs text-muted-foreground">
                Mark this event as reviewed and trusted.
              </span>
            </div>
            <Switch id="event-verified" checked={verified} onCheckedChange={setVerified} />
          </div>

          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="event-hidden">Hidden</Label>
              <span className="text-xs text-muted-foreground">
                Hide this event from pickers and reports.
              </span>
            </div>
            <Switch id="event-hidden" checked={hidden} onCheckedChange={setHidden} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
