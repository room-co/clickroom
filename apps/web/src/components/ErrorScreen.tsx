import { AlertCircle, Check, ChevronDown, Copy, MousePointer } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { getDeployment } from '@/lib/runtime-config'

/** Hosted-cloud support address; self-hosted installs have no Clickroom support channel. */
const CLOUD_SUPPORT_EMAIL = 'support@clickroom.co'

interface Props {
  error: Error
  componentStack?: string | null
  onReload: () => void
  onReset: () => void
}

/**
 * Shared crash-screen presentation, rendered by both the top-level render-time
 * ErrorBoundary (componentDidCatch) and the router's per-route errorElement
 * (useRouteError) — the two React error-handling paths never fire together, so
 * one presentational component covers both.
 */
export function ErrorScreen({ error, componentStack, onReload, onReset }: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [errorId] = useState(() => `err_${Math.random().toString(36).slice(2, 9)}`)

  function copyDetails() {
    const text = [
      `Error: ${error.message}`,
      '',
      'Stack:',
      error.stack,
      '',
      'Component stack:',
      componentStack,
    ].join('\n')
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-6"
      style={{
        backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)',
        backgroundSize: '28px 28px',
      }}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 mb-12">
        <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center shrink-0">
          <MousePointer className="w-3.5 h-3.5 text-primary-foreground" />
        </div>
        <span className="font-semibold text-sm tracking-tight text-foreground">
          click<span className="text-primary">room</span>
        </span>
      </div>

      {/* Card */}
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-8">
        {/* Icon */}
        <div className="w-12 h-12 rounded-full flex items-center justify-center mb-5 mx-auto bg-destructive/10 border border-destructive/20">
          <AlertCircle className="w-[22px] h-[22px] text-destructive" />
        </div>

        <h1 className="text-lg font-semibold text-center mb-2 text-foreground">
          Something went wrong
        </h1>
        <p className="text-sm text-center mb-1 text-muted-foreground">
          An unexpected error caused this page to crash.
        </p>
        <p className="text-[11px] text-center font-mono mb-6 text-muted-foreground">
          Error ID: {errorId}
        </p>

        {/* Error message pill */}
        <div className="rounded-lg px-4 py-3 mb-6 font-mono text-xs break-all bg-destructive/5 border border-destructive/15 text-destructive">
          {error.message || 'Unknown error'}
        </div>

        {/* Actions */}
        <div className="flex gap-3 mb-5">
          <Button onClick={onReload} className="flex-1">
            Reload page
          </Button>
          <Button onClick={onReset} variant="outline" className="flex-1">
            Try again
          </Button>
        </div>

        {/* Technical details (collapsible) */}
        <div className="border-t border-border pt-4">
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            className="flex items-center justify-between w-full text-left"
          >
            <span className="text-[11px] font-medium text-muted-foreground">Technical details</span>
            <div className="flex items-center gap-2">
              {detailsOpen && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    copyDetails()
                  }}
                  className={`text-[10px] flex items-center gap-1 transition-colors ${
                    copied ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  {copied ? (
                    <>
                      <Check className="w-[11px] h-[11px]" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-[11px] h-[11px]" />
                      Copy
                    </>
                  )}
                </button>
              )}
              <ChevronDown
                className="w-3 h-3 text-muted-foreground transition-transform"
                style={{ transform: detailsOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
              />
            </div>
          </button>

          {detailsOpen && (
            <div className="mt-3 rounded-lg p-3 overflow-auto max-h-48 bg-black/30 border border-border">
              <pre className="text-[10px] font-mono leading-relaxed whitespace-pre-wrap break-all text-muted-foreground">
                {error.stack}
                {componentStack && `\n\nComponent stack:${componentStack}`}
              </pre>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <p className="mt-6 text-[11px] text-muted-foreground">
        {getDeployment() === 'cloud' ? (
          <>
            If this keeps happening,{' '}
            <a
              href={`mailto:${CLOUD_SUPPORT_EMAIL}`}
              className="underline underline-offset-2 transition-colors hover:text-foreground"
            >
              contact support
            </a>{' '}
            with error ID <span className="font-mono">{errorId}</span>.
          </>
        ) : (
          <>
            If this keeps happening, check your server logs and include error ID{' '}
            <span className="font-mono">{errorId}</span> when reporting it.
          </>
        )}
      </p>
    </div>
  )
}
