import * as React from 'react'

import { cn } from '@/lib/utils'

// Ported from apps/web/src/components/ui/input.tsx, adapted to this app's dark-only token set:
// apps/web's `bg-input-background` token doesn't exist here (apps/admin/src/styles/index.css
// only defines `--color-input` for borders, matching plain shadcn new-york), so this uses
// `bg-input/30` directly instead of the light/dark split apps/web needs.
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground bg-input/30 border-input flex h-9 w-full min-w-0 rounded-md border px-3 py-1 text-base transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
