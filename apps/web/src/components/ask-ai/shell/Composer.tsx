import { ArrowUp, Loader2 } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

interface ComposerProps {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  isBusy: boolean
  disabled: boolean
  placeholder: string
  errorMessage?: string
}

// Rounded input bar + send button + a disclaimer footer, sticky at the
// bottom of the transcript.
export function Composer({
  value,
  onChange,
  onSubmit,
  isBusy,
  disabled,
  placeholder,
  errorMessage,
}: ComposerProps) {
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSubmit()
    }
  }

  return (
    <div className="shrink-0 border-t border-border bg-background px-3 pb-3 pt-2 sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        {errorMessage && <p className="pb-2 text-xs text-destructive">{errorMessage}</p>}
        <div
          className={cn(
            'flex items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm transition-shadow',
            'focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40',
          )}
        >
          <Textarea
            value={value}
            onChange={(e) => onChange(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={1}
            className="min-h-9 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
          />
          <Button
            type="button"
            size="icon"
            onClick={onSubmit}
            disabled={disabled}
            className="shrink-0 rounded-xl"
          >
            {isBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </Button>
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
          Ask AI can make mistakes. Verify important numbers and confirm actions carefully.
        </p>
      </div>
    </div>
  )
}
