import type { ReactNode } from 'react'

export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 px-4 md:px-6 py-4 border-b border-border shrink-0">
      <div>
        <h1 className="text-sm font-semibold text-foreground tracking-tight">{title}</h1>
        {subtitle && <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center flex-wrap gap-2">{children}</div>}
    </div>
  )
}
