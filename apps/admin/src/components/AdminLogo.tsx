import { MousePointer } from 'lucide-react'

/** Login-flow wordmark — same mark as apps/web's `AuthLogo`, but in the admin console's own
 * amber "operator" token color (theme.css) rather than web's teal, so the two surfaces never
 * look interchangeable. */
export function AdminLogo() {
  return (
    <div className="flex items-center gap-2.5 mb-8 justify-center">
      <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
        <MousePointer className="w-4 h-4 text-primary-foreground" />
      </div>
      <span className="font-semibold text-base tracking-tight text-foreground">
        click<span className="text-primary">room</span>
        <span className="ml-1.5 text-muted-foreground font-normal">Admin</span>
      </span>
    </div>
  )
}
