import { MousePointer } from 'lucide-react'
import { cn } from '@/lib/utils'

export function AuthGrid() {
  return (
    <div
      className="fixed inset-0 pointer-events-none"
      style={{
        backgroundImage:
          'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
        backgroundSize: '40px 40px',
      }}
    />
  )
}

export function AuthLogo() {
  return (
    <div className="flex items-center gap-2.5 mb-8 justify-center">
      <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
        <MousePointer className="w-4 h-4 text-primary-foreground" />
      </div>
      <span className="font-semibold text-base tracking-tight text-foreground">
        click<span className="text-primary">room</span>
      </span>
    </div>
  )
}

export function AuthSpinner() {
  return (
    <svg
      className="animate-spin w-3.5 h-3.5"
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label="Loading"
    >
      <title>Loading</title>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"
      />
    </svg>
  )
}

export function PasswordStrength({ password }: { password: string }) {
  const checks = [
    { label: '8+ characters', pass: password.length >= 8 },
    { label: 'Uppercase letter', pass: /[A-Z]/.test(password) },
    { label: 'Number or symbol', pass: /[0-9!@#$%^&*]/.test(password) },
  ]
  const score = checks.filter((c) => c.pass).length
  const colors = ['bg-red-500', 'bg-amber-400', 'bg-teal-400']
  const labels = ['Weak', 'Fair', 'Strong']

  if (!password) return null

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={cn(
              'h-0.5 flex-1 rounded-full transition-colors duration-300',
              i < score ? colors[score - 1] : 'bg-muted',
            )}
          />
        ))}
      </div>
      <div className="flex items-center justify-between">
        <div className="flex gap-3">
          {checks.map((c) => (
            <span
              key={c.label}
              className={cn(
                'text-[10px] transition-colors',
                c.pass ? 'text-teal-400' : 'text-muted-foreground/60',
              )}
            >
              {c.pass ? '✓' : '·'} {c.label}
            </span>
          ))}
        </div>
        {score > 0 && (
          <span
            className={cn('text-[10px] font-medium', colors[score - 1].replace('bg-', 'text-'))}
          >
            {labels[score - 1]}
          </span>
        )}
      </div>
    </div>
  )
}
