// Animated "thinking…" label. Uses Tailwind's built-in `animate-pulse` (no
// `motion` dependency and no new `@keyframes` needed, unlike the reference implementation's
// gradient-sweep port) — a simple opacity pulse reads clearly as "working"
// without adding animation-library weight for one label.
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Shimmer({ className, children, ...props }: ComponentProps<'span'>) {
  return (
    <span className={cn('inline-block animate-pulse text-muted-foreground', className)} {...props}>
      {children}
    </span>
  )
}
