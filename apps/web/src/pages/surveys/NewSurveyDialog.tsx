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
import { type SurveyTemplate, starterDefinition, TEMPLATE_LABELS, toApiDefinition } from './types'

const TEMPLATES: readonly SurveyTemplate[] = ['csat', 'ces', 'nps', 'blank']

/**
 * Create dialog (spinner on submit, mirrors NewFlagDialog). A survey is born
 * `draft` with a starter `definition` chosen from a preset; the builder is where
 * it's shaped and enabled. On success we jump straight into the builder.
 */
export function NewSurveyDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string
  onClose: () => void
  onCreated: (surveyId: string) => void
}) {
  const utils = trpc.useUtils()
  const create = trpc.surveys.create.useMutation()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [template, setTemplate] = useState<SurveyTemplate>('csat')
  const [error, setError] = useState('')

  const canSubmit = name.trim() !== ''

  async function handleCreate() {
    if (!canSubmit) {
      setError('A survey name is required.')
      return
    }
    setError('')
    try {
      const survey = await create.mutateAsync({
        projectId,
        name: name.trim(),
        description: description.trim() || undefined,
        // The strict zod schema is satisfied by the serialized preset.
        definition: toApiDefinition(starterDefinition(template)) as never,
      })
      await utils.surveys.list.invalidate()
      track('survey_created', { survey_id: survey.id, template })
      toast.success('Survey created')
      onCreated(survey.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create survey')
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
          <div className="text-sm font-semibold text-foreground">New survey</div>
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
            <label htmlFor="new-survey-name" className="text-[11px] text-muted-foreground">
              Name
            </label>
            <input
              id="new-survey-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Post-checkout CSAT"
              className="w-full rounded border border-border bg-muted/30 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="new-survey-desc" className="text-[11px] text-muted-foreground">
              Description
            </label>
            <input
              id="new-survey-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
              className="w-full rounded border border-border bg-muted/30 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>

          <div className="space-y-1.5">
            <div className="text-[11px] text-muted-foreground">Template</div>
            <Select value={template} onValueChange={(v) => setTemplate(v as SurveyTemplate)}>
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
              A starter question you can reshape in the builder. Surveys start as a draft and stay
              hidden until you activate them.
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
            {create.isPending ? 'Creating…' : 'Create survey'}
          </button>
        </div>
      </div>
    </div>
  )
}
