import { AlertTriangle, Check, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { humanizeToolName, type ToolPart } from '../tool-parts'

function renderArgValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function ToolArgs({ input }: { input: unknown }) {
  if (input == null || typeof input !== 'object') return null
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length === 0) return null
  return (
    <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{humanizeToolName(k)}</dt>
          <dd className="break-words font-medium text-foreground">{renderArgValue(v)}</dd>
        </div>
      ))}
    </dl>
  )
}

interface ApprovalGateProps {
  part: ToolPart
  toolName: string
  confirming: boolean
  onResolve: (part: ToolPart, toolName: string, args: unknown, approved: boolean) => void
}

/**
 * Inline card asking the user to confirm a mutating tool call (read
 * tools auto-execute, mutating tools pause here). Approve POSTs
 * `/ai/chat/tool-confirm` with `approved: true` and applies the mutation
 * through the real tRPC pipeline; Decline POSTs `approved: false` so the
 * tool is recorded as declined and never run, and the stream still resumes
 * so the model can acknowledge the decision.
 */
export function ApprovalGate({ part, toolName, confirming, onResolve }: ApprovalGateProps) {
  return (
    <div className="w-full max-w-full rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3 sm:p-4">
      <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span className="text-sm font-medium">Confirm action: {humanizeToolName(toolName)}</span>
      </div>
      <ToolArgs input={part.input} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={confirming}
          className="bg-amber-500 text-white hover:bg-amber-500/90"
          onClick={() => onResolve(part, toolName, part.input, true)}
        >
          {confirming ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={confirming}
          onClick={() => onResolve(part, toolName, part.input, false)}
        >
          <X className="h-3.5 w-3.5" />
          Decline
        </Button>
      </div>
    </div>
  )
}
