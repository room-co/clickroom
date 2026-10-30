import { Loader2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { track } from '@/lib/analytics'
import { trpc } from '@/lib/trpc'
import { type SupportTemplate, starterDefinition, TEMPLATE_LABELS, toApiDefinition } from './types'

const TEMPLATES: readonly SupportTemplate[] = ['contact', 'bug', 'blank']

/**
 * Create dialog (spinner on submit, mirrors NewSurveyDialog). A support form is
 * born `draft` with a starter `definition` chosen from a preset; the builder is
 * where it's shaped and enabled. On success we jump straight into the builder.
 */
export function NewSupportFormDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string
  onClose: () => void
  onCreated: (formId: string) => void
}) {
  const utils = trpc.useUtils()
  const create = trpc.support.create.useMutation()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [template, setTemplate] = useState<SupportTemplate>('contact')
  const [error, setError] = useState('')

  const canSubmit = name.trim() !== ''

  async function handleCreate() {
    if (!canSubmit) {
      setError('A form name is required.')
      return
    }
    setError('')
    try {
      const form = await create.mutateAsync({
        projectId,
        name: name.trim(),
        description: description.trim() || undefined,
        // The strict zod schema is satisfied by the serialized preset.
        definition: toApiDefinition(starterDefinition(template)) as never,
      })
      await utils.support.list.invalidate()
      track('support_form_created', { form_id: form.id, template })
      toast.success('Support form created')
      onCreated(form.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create support form')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div className="relative w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl shadow-black/50">
        <div className="mb-5 flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">New support form</div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="new-support-name" className="text-[11px] text-muted-foreground">
              Name
            </label>
            <input
              id="new-support-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="In-app help"
              className="w-full rounded border border-border bg-muted/30 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="new-support-desc" className="text-[11px] text-muted-foreground">
              Description
            </label>
            <input
              id="new-support-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
              className="w-full rounded border border-border bg-muted/30 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>

          <div className="space-y-1.5">
            <div className="text-[11px] text-muted-foreground">Template</div>
            <Select value={template} onValueChange={(v) => setTemplate(v as SupportTemplate)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TEMPLATES.map((t) => (
                  <SelectItem key={t} value={t} className="text-xs">
                    {TEMPLATE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] leading-snug text-muted-foreground">
              Starter fields you can reshape in the builder. Forms start as a draft and stay hidden
              until you activate them.
            </p>
          </div>

          {error && <p className="text-[11px] font-medium text-red-400">{error}</p>}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={create.isPending}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={create.isPending || !canSubmit}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {create.isPending ? 'Creating…' : 'Create form'}
          </button>
        </div>
      </div>
    </div>
  )
}
