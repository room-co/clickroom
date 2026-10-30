import { Check, Lock } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { AuthGrid, AuthLogo, AuthSpinner, PasswordStrength } from '@/components/auth-ui'
import { track } from '@/lib/analytics'
import { setToken } from '@/lib/auth'
import { getDeployment } from '@/lib/runtime-config'
import { trpc } from '@/lib/trpc'
import { useInternalFlag } from '@/lib/use-internal-flag'
import { cn } from '@/lib/utils'

const inputCls =
  'w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 focus:border-primary/40 transition-colors'

const slugify = (val: string) =>
  val
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

/**
 * Shown instead of the form while the pre-GA signup gate is closed. Sign-in and
 * invite acceptance are unaffected — only creating a new workspace is gated.
 */
function SignupClosedNotice() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <AuthGrid />
      <div className="w-full max-w-[380px] relative">
        <AuthLogo />

        <div className="bg-card border border-border rounded-xl p-7 shadow-2xl shadow-black/40">
          <div className="w-8 h-8 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
            <Lock className="w-3.5 h-3.5 text-primary" />
          </div>
          <h2 className="text-sm font-semibold text-foreground mb-1.5">Signups are invite-only</h2>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Account creation is closed. If someone invited you, open their invite link to join their
            workspace — you don't need an account first.
          </p>
        </div>

        <p className="text-center text-[11px] text-muted-foreground mt-5">
          Already have an account?{' '}
          <Link
            to="/login"
            className="text-primary hover:opacity-80 transition-opacity font-medium"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}

export function SignupPage() {
  const navigate = useNavigate()
  const signup = trpc.auth.signup.useMutation()
  // Cosmetic half of the gate — `auth.signup` re-checks the same flag server-side
  // (see signup-gate.ts), which is what actually closes signups. Note the two
  // halves evaluate with different distinct_ids: the browser SDK uses the
  // anonymous device id, the server uses the submitted email. They agree for a
  // plain 100%-on kill switch; a percentage rollout or an email-property rule
  // can show the form here and still be rejected on submit.
  const gated = useInternalFlag('internal-signups-gated', false)
  const signupStatus = trpc.auth.signupStatus.useQuery()
  const ownerSetup = signupStatus.data?.ownerSetup === true
  // Self-hosted: no plans, no marketing stats, no hosted-product legal links.
  const selfHost = getDeployment() === 'self_host'
  const [name, setName] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name || !workspace || !email || !password) {
      setError('Please fill in all fields.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (!selfHost && !agreed) {
      setError('You must agree to the terms to continue.')
      return
    }
    setError(null)
    try {
      const data = await signup.mutateAsync({ email, password, orgName: workspace })
      setToken(data.accessToken)
      track('signup_completed', { plan: 'free' })
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create account.')
    }
  }

  if (gated) return <SignupClosedNotice />

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <AuthGrid />
      <div className="w-full max-w-[380px] relative">
        <AuthLogo />

        {!selfHost && (
          /* Plan pill */
          <div className="flex justify-center mb-6">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-primary/10 border border-primary/20 rounded-full text-[11px] text-primary font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
              Starter plan · Free forever · No credit card
            </div>
          </div>
        )}

        <div className="bg-card border border-border rounded-xl p-7 shadow-2xl shadow-black/40">
          <h2 className="text-sm font-semibold text-foreground mb-0.5">
            {ownerSetup ? 'Create the owner account' : 'Create your account'}
          </h2>
          <p className="text-[11px] text-muted-foreground mb-6">
            {selfHost
              ? 'Set up your self-hosted Clickroom.'
              : 'Start tracking clicks in under 2 minutes.'}
          </p>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="signup-name"
                  className="block text-[11px] font-medium text-muted-foreground mb-1.5"
                >
                  Full name
                </label>
                <input
                  id="signup-name"
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Alex Chen"
                  autoComplete="name"
                  className={inputCls}
                />
              </div>
              <div>
                <label
                  htmlFor="signup-email"
                  className="block text-[11px] font-medium text-muted-foreground mb-1.5"
                >
                  Work email
                </label>
                <input
                  id="signup-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="alex@acme.co"
                  autoComplete="email"
                  className={inputCls}
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="signup-workspace"
                className="block text-[11px] font-medium text-muted-foreground mb-1.5"
              >
                Workspace name
              </label>
              <input
                id="signup-workspace"
                type="text"
                value={workspace}
                onChange={(event) => setWorkspace(event.target.value)}
                placeholder="Acme Inc."
                className={inputCls}
              />
              {workspace && !selfHost && (
                <p className="mt-1 text-[10px] text-muted-foreground font-mono">
                  click<span className="text-primary">room</span>.co/
                  <span className="text-foreground">{slugify(workspace)}</span>
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="signup-password"
                className="block text-[11px] font-medium text-muted-foreground mb-1.5"
              >
                Password
              </label>
              <input
                id="signup-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••••"
                autoComplete="new-password"
                className={inputCls}
              />
              <PasswordStrength password={password} />
            </div>

            {!selfHost && (
              <div className="flex items-start gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => setAgreed(!agreed)}
                  className={cn(
                    'w-4 h-4 rounded border shrink-0 mt-0.5 flex items-center justify-center transition-colors',
                    agreed
                      ? 'bg-primary border-primary'
                      : 'border-border bg-muted/30 hover:border-primary/50',
                  )}
                  aria-label="Agree to terms"
                >
                  {agreed && <Check className="w-2.5 h-2.5 text-primary-foreground" />}
                </button>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  I agree to the{' '}
                  <button
                    type="button"
                    className="text-primary hover:opacity-80 transition-opacity"
                  >
                    Terms of Service
                  </button>{' '}
                  and{' '}
                  <button
                    type="button"
                    className="text-primary hover:opacity-80 transition-opacity"
                  >
                    Privacy Policy
                  </button>
                  .
                </p>
              </div>
            )}

            {error && <p className="text-[11px] text-red-400 font-medium">{error}</p>}

            <button
              type="submit"
              disabled={signup.isPending}
              className="w-full bg-primary text-primary-foreground text-xs font-semibold py-2.5 rounded-md hover:opacity-90 transition-opacity disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {signup.isPending ? (
                <>
                  <AuthSpinner />
                  Creating account...
                </>
              ) : selfHost ? (
                'Create account'
              ) : (
                'Create free account'
              )}
            </button>
          </form>

          {!selfHost && (
            <div className="mt-5 pt-5 border-t border-border">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-center">
                {[
                  { stat: '100k', label: 'events/mo free' },
                  { stat: '< 2min', label: 'to first event' },
                  { stat: 'SOC 2', label: 'Type II certified' },
                ].map(({ stat, label }) => (
                  <div key={stat}>
                    <div className="font-mono text-xs font-semibold text-foreground">{stat}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <p className="text-center text-[11px] text-muted-foreground mt-5">
          Already have an account?{' '}
          <Link
            to="/login"
            className="text-primary hover:opacity-80 transition-opacity font-medium"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
