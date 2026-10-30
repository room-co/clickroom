// Minimal message-bubble primitives. Deliberately plain-text (no
// `streamdown` markdown renderer, unlike the reference implementation's port) — keeps the new
// dependency surface small; assistant prose renders fine as
// `whitespace-pre-wrap`, and Ask AI replies are meant to be short/direct
// (anti-sycophancy system prompt) rather than richly formatted markdown docs.
import type { ComponentProps, HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: 'user' | 'assistant' | 'system'
}

export function Message({ className, from, ...props }: MessageProps) {
  return (
    <div
      className={cn(
        'group flex w-full max-w-full flex-col gap-2',
        from === 'user' ? 'is-user ml-auto items-end' : 'is-assistant items-start',
        className,
      )}
      {...props}
    />
  )
}

export function MessageContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex w-fit min-w-0 max-w-full flex-col gap-2 text-sm',
        'group-[.is-user]:rounded-2xl group-[.is-user]:bg-primary group-[.is-user]:px-4 group-[.is-user]:py-2.5 group-[.is-user]:text-primary-foreground',
        'group-[.is-assistant]:w-full group-[.is-assistant]:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

export function MessageResponse({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      className={cn(
        'whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground',
        className,
      )}
      {...props}
    />
  )
}
