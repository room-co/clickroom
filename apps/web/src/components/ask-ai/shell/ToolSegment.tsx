import { ChevronDown, Wrench } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { humanizeToolName, type ToolPart } from '../tool-parts'
import { adaptToolPart } from '../widgets/adapter'
import { WidgetRenderer } from '../widgets/WidgetRenderer'

function truncatedJson(value: unknown, max = 800): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Collapsed fallback trace card: name + truncated input/output JSON. Used
 * for any tool without a mapped widget, or if the widget adapter throws. */
function ToolTraceCard({ toolName, parts }: { toolName: string; parts: ToolPart[] }) {
  const [open, setOpen] = useState(false)
  const count = parts.length
  const label = count > 1 ? `${humanizeToolName(toolName)} (×${count})` : humanizeToolName(toolName)

  return (
    <div className="w-full max-w-full overflow-hidden rounded-lg border border-border bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <Wrench className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 truncate">{label}</span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-3 py-2">
          {parts.map((part, i) => (
            <div key={part.toolCallId ?? i} className="space-y-1">
              {part.input != null && (
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[11px] text-muted-foreground">
                  {truncatedJson(part.input)}
                </pre>
              )}
              {(part.output !== undefined || part.errorText) && (
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[11px] text-foreground">
                  {truncatedJson(part.errorText ?? part.output)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Renders a `tools` segment (consecutive same-tool calls folded together):
 * tries `adaptToolPart` (widget adapter) for each completed part
 * with output, falling back to the collapsed trace card for the whole group
 * on any unmapped tool or adapter error — never crashes the message list.
 */
export function ToolSegment({ toolName, parts }: { toolName: string; parts: ToolPart[] }) {
  const descriptors = parts.flatMap((part) => {
    if (part.state !== 'output-available' || part.output === undefined) return []
    try {
      const descriptor = adaptToolPart(toolName, part.output)
      return descriptor ? [descriptor] : []
    } catch (err) {
      console.error('[ask-ai] widget adapter failed', toolName, err)
      return []
    }
  })

  if (descriptors.length === 0) {
    return <ToolTraceCard toolName={toolName} parts={parts} />
  }

  return (
    <div className="w-full max-w-full space-y-2">
      {descriptors.map((descriptor, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: descriptors are static and never reordered
        <WidgetRenderer key={i} descriptor={descriptor} />
      ))}
    </div>
  )
}
