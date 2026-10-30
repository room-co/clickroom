import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'
import { CopyButton } from '@/components/CopyButton'
import { cn } from '@/lib/utils'

/**
 * Masked secret + reveal toggle + copy — generalized from the
 * API-key prefix cell in `ApiKeysPage`.
 *
 * Two modes, because not every secret in the app is revealable:
 *  - `value` given → the eye toggle swaps the mask for the plaintext.
 *  - `value` omitted (only `masked`) → no toggle at all. This is the webhook
 *    signing-secret case: the control plane cannot decrypt the stored secret, so
 *    `whsec_••••3f7a` is *all* there is (constraint 7).
 *
 * Reveal state is uncontrolled by default; pass `revealed`/`onRevealedChange` to
 * hoist it (e.g. a table where only one row may be open at a time).
 */
export function SecretField({
  value,
  masked,
  revealed: revealedProp,
  onRevealedChange,
  copyable = true,
  copyValue,
  className,
  valueClassName,
  label = 'secret',
}: {
  /** Plaintext. Omit when the secret is not retrievable — mask-only. */
  value?: string
  /** What to show while hidden. Defaults to a fixed-width dot mask. */
  masked?: string
  /** Controlled reveal state. Omit for internal state. */
  revealed?: boolean
  onRevealedChange?: (next: boolean) => void
  /** Render the copy button. */
  copyable?: boolean
  /** Overrides what gets copied; defaults to `value ?? masked`. */
  copyValue?: string
  className?: string
  valueClassName?: string
  /** Used in the aria-labels ("Reveal signing secret"). */
  label?: string
}) {
  const [internalRevealed, setInternalRevealed] = useState(false)
  const isControlled = revealedProp !== undefined
  const revealed = isControlled ? revealedProp : internalRevealed

  function toggle() {
    const next = !revealed
    if (!isControlled) setInternalRevealed(next)
    onRevealedChange?.(next)
  }

  const maskedText = masked ?? '••••••••••••'
  const shown = revealed && value !== undefined ? value : maskedText
  const toCopy = copyValue ?? value ?? maskedText

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <span className={cn('font-mono text-muted-foreground', valueClassName)}>{shown}</span>
      {value !== undefined && (
        <button
          type="button"
          onClick={toggle}
          aria-label={`${revealed ? 'Hide' : 'Reveal'} ${label}`}
          className="text-muted-foreground/60 transition-colors hover:text-muted-foreground"
        >
          {revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        </button>
      )}
      {copyable && <CopyButton value={toCopy} ariaLabel={`Copy ${label}`} />}
    </div>
  )
}
