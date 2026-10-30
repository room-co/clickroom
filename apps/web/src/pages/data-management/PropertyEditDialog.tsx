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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc'
import type { PropertyType, SerializedProperty } from './types'

const PROPERTY_TYPES: PropertyType[] = ['String', 'Numeric', 'Boolean', 'DateTime']

type PropertyEditDialogProps = {
  projectId: string
  scope: 'event' | 'person'
  property: SerializedProperty | null
  onClose: () => void
}

export function PropertyEditDialog({
  projectId,
  scope,
  property,
  onClose,
}: PropertyEditDialogProps) {
  const utils = trpc.useUtils()
  const [description, setDescription] = useState('')
  const [verified, setVerified] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [propertyType, setPropertyType] = useState<PropertyType>('String')

  useEffect(() => {
    if (property) {
      setDescription(property.description ?? '')
      setVerified(property.verified)
      setHidden(property.hidden)
      setPropertyType(property.propertyType)
    }
  }, [property])

  const update = trpc.taxonomy.properties.update.useMutation({
    onSuccess: async () => {
      await utils.taxonomy.properties.list.invalidate()
      toast.success('Property updated')
      onClose()
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to update property')
    },
  })

  const typeChanged = property ? propertyType !== property.propertyType : false

  function handleSave() {
    if (!property) return
    update.mutate({
      projectId,
      id: property.id,
      description: description.trim() === '' ? null : description.trim(),
      verified,
      hidden,
      // Only send propertyType when it actually changes — sending it locks the
      // type permanently, so avoid locking a property the user never touched.
      ...(typeChanged && { propertyType }),
    })
  }

  return (
    <Dialog open={!!property} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {scope} property</DialogTitle>
          <DialogDescription>
            {property ? (
              <span className="font-mono text-xs">{property.name}</span>
            ) : (
              'Update the definition for this property.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 py-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="property-description">Description</Label>
            <Textarea
              id="property-description"
              placeholder="Describe what this property captures…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="property-type">Type</Label>
            <Select
              value={propertyType}
              onValueChange={(v) => setPropertyType(v as PropertyType)}
              disabled={property?.typeLocked}
            >
              <SelectTrigger id="property-type">
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
            {property?.typeLocked ? (
              <span className="text-xs text-muted-foreground">
                The type is locked and can no longer be changed.
              </span>
            ) : (
              <span className="text-xs text-amber-500">
                Setting a type locks it permanently — discovery will stop inferring it.
              </span>
            )}
          </div>

          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="property-verified">Verified</Label>
              <span className="text-xs text-muted-foreground">
                Mark this property as reviewed and trusted.
              </span>
            </div>
            <Switch id="property-verified" checked={verified} onCheckedChange={setVerified} />
          </div>

          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="property-hidden">Hidden</Label>
              <span className="text-xs text-muted-foreground">
                Hide this property from pickers and reports.
              </span>
            </div>
            <Switch id="property-hidden" checked={hidden} onCheckedChange={setHidden} />
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
