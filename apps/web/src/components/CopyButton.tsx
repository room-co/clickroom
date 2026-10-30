import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The single copy-to-clipboard control for the app.
 *
 * Replaces the three hand-rolled copies that existed before it — `CodeBlock`,
 * `SsoSettingsPage`'s `CopyField` and `ApiKeysPage`'s `KeyRevealModal` — all of
 * which reimplemented the same 2s "copied" flash with subtly different failure
 * handling (one silent, one unguarded). Behaviour here is the `ApiKeysPage` one:
 * flash for 2s, `toast.error` when the Clipboard API rejects (insecure context,
 * denied permission).
 *
 * Two shapes:
 *  - `variant="inline"` (default) — a bare text+icon button that sits inside a
 *    toolbar strip (`CodeBlock`, key reveal modal).
 *  - `variant="outline"` — a shadcn `Button` for standalone use beside a field.
 */
export function CopyButton({
  value,
  label,
  copiedLabel = 'Copied!',
  successMessage,
  variant = 'inline',
  className,
  iconClassName,
  copiedIconClassName,
  ariaLabel,
  disabled,
}: {
  /** Text written to the clipboard. */
  value: string
  /** Text beside the icon. Omit for an icon-only button. */
  label?: string
  /** Text beside the icon while flashing; ignored when `label` is omitted. */
  copiedLabel?: string
  /** Success toast body. Omit for no toast (the flash is the feedback). */
  successMessage?: string
  variant?: 'inline' | 'outline'
  className?: string
  /** Icon sizing/colour override. Defaults to h-3 w-3 inline, h-4 w-4 outline. */
  iconClassName?: string
  /** Extra classes on the `Check` icon only — the per-surface accent colour
   *  (`text-primary`, `text-teal-400`). Omit to inherit the button's colour. */
  copiedIconClassName?: string
  ariaLabel?: string
  disabled?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Unmounting mid-flash (a sheet closing, a row re-keying) would otherwise set
  // state on a dead component.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (successMessage) toast.success(successMessage)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Failed to copy')
    }
  }

  const icon = copied ? (
    <Check
      className={cn(
        iconClassName ?? (variant === 'outline' ? 'h-4 w-4' : 'h-3 w-3'),
        copiedIconClassName,
      )}
    />
  ) : (
    <Copy className={cn(iconClassName ?? (variant === 'outline' ? 'h-4 w-4' : 'h-3 w-3'))} />
  )

  if (variant === 'outline') {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleCopy}
        disabled={disabled}
        aria-label={ariaLabel ?? (label ? undefined : 'Copy')}
        className={className}
      >
        {icon}
        {label ? (copied ? copiedLabel : label) : null}
      </Button>
    )
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={disabled}
      aria-label={ariaLabel ?? (label ? undefined : 'Copy')}
      className={cn(
        'flex items-center gap-1.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50',
        className,
      )}
    >
      {icon}
      {label ? (copied ? copiedLabel : label) : null}
    </button>
  )
}
