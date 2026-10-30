import { CopyButton } from '@/components/CopyButton'
import { cn } from '@/lib/utils'

/**
 * A minimal copy-pasteable code block: monospace `<pre>` (no syntax highlighter
 * dependency in this app) plus the shared `CopyButton`.
 */
export function CodeBlock({
  code,
  language,
  className,
}: {
  code: string
  language?: string
  className?: string
}) {
  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-muted/30', className)}>
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        {language && (
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {language}
          </span>
        )}
        <CopyButton
          value={code}
          label="Copy"
          copiedIconClassName="text-primary"
          className="ml-auto"
        />
      </div>
      <div className="overflow-x-auto">
        <pre className="px-3 py-3 text-xs leading-relaxed">
          <code className="whitespace-pre font-mono text-foreground">{code}</code>
        </pre>
      </div>
    </div>
  )
}
