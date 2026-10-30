import { TRPCClientError } from '@trpc/client'
import { Eye, EyeOff } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { AuthLogo, AuthSpinner } from '@/components/auth-ui'
import { track } from '@/lib/analytics'
import { setToken } from '@/lib/auth'
import { getApiBase, getDeployment } from '@/lib/runtime-config'
import { trpc } from '@/lib/trpc'
import { cn } from '@/lib/utils'

// `/auth/sso/*` is served by apps/api, not apps/web — same cross-port-in-dev
// situation as `useAskAIChat.ts`/`McpPage.tsx`; VITE_API_ORIGIN must be set
// via runtime config (`/config.js` apiOrigin; empty = same-origin).
const API_ORIGIN = getApiBase()

interface SsoDiscovery {
  connectionId: string
  startUrl: string
}

// Email-first SSO discovery: resolves an org's enabled SSO
// connection from the email's domain. 200 -> render a "Continue with SSO"
// option; 204/any error is an expected non-SSO case and silently falls
// through to password-only — never surfaced as a login error.
async function discoverSso(email: string): Promise<SsoDiscovery | null> {
  try {
    const res = await fetch(`${API_ORIGIN}/auth/sso/discover?email=${encodeURIComponent(email)}`, {
      credentials: 'include',
    })
    if (res.status !== 200) return null
    const data = (await res.json()) as SsoDiscovery
    if (!data.connectionId || !data.startUrl) return null
    return data
  } catch {
    return null
  }
}

const inputCls = cn(
  'w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5',
  'text-foreground placeholder:text-muted-foreground/60 focus:outline-none',
  'focus:ring-1 focus:ring-primary/60 focus:border-primary/40 transition-colors',
)

// Jagged trend-line polyline, one point per "data tick". The first and last
// point share the same y, so tiling the path at x=0 and x=1440 and translating
// by exactly one tile width (1440px) makes the scroll loop with zero seam —
// same trick as before, but the shape reads as chart data, not a sine wave.
function trendPath(points: [number, number][]) {
  const [head, ...rest] = points
  return `M${head[0]},${head[1]} L${rest.map(([x, y]) => `${x},${y}`).join(' L')}`
}

const TEAL_POINTS: [number, number][] = [
  [0, 470],
  [120, 430],
  [260, 450],
  [400, 360],
  [540, 395],
  [680, 300],
  [820, 335],
  [960, 255],
  [1100, 290],
  [1250, 240],
  [1350, 340],
  [1440, 470],
]
const VIOLET_POINTS: [number, number][] = [
  [0, 640],
  [150, 610],
  [300, 625],
  [460, 560],
  [620, 585],
  [780, 520],
  [940, 545],
  [1100, 500],
  [1250, 530],
  [1350, 580],
  [1440, 640],
]

const TEAL_LINE = trendPath(TEAL_POINTS)
const VIOLET_LINE = trendPath(VIOLET_POINTS)

// A dot per data point. The last point is skipped — it sits at the same screen
// position as the next tile's first point (x=0), so drawing both would just
// stack two identical dots.
function markerDots(points: [number, number][], stagger: number): [number, number, number][] {
  return points.slice(0, -1).map(([x, y], i) => [x, y, i * stagger])
}

const TEAL_DOTS = markerDots(TEAL_POINTS, 0.35)
const VIOLET_DOTS = markerDots(VIOLET_POINTS, 0.4)

function TrendDots({
  dots,
  color,
  period,
}: {
  dots: [number, number, number][]
  color: string
  period: number
}) {
  return (
    <>
      {dots.map(([cx, cy, delay]) => (
        <g key={cx} style={{ transformOrigin: `${cx}px ${cy}px` }}>
          <circle cx={cx} cy={cy} r="7" fill={color} fillOpacity="0.12" />
          <circle
            cx={cx}
            cy={cy}
            r="3.5"
            fill={color}
            fillOpacity="0.85"
            className="cr-anim"
            style={{
              animation: `cr-pulse ${period}s ease-in-out ${delay}s infinite`,
              transformOrigin: `${cx}px ${cy}px`,
            }}
          />
        </g>
      ))}
    </>
  )
}

function LoginChartBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <style>{`
        @keyframes cr-marquee {
          from { transform: translateX(0); }
          to   { transform: translateX(-1440px); }
        }
        @keyframes cr-pulse {
          0%, 100% { opacity: 0.4; transform: scale(0.85); }
          50%      { opacity: 1; transform: scale(1.15); }
        }
        @media (prefers-reduced-motion: reduce) {
          .cr-anim { animation: none !important; }
          .cr-marquee-track { transform: translateX(-720px) !important; }
        }
      `}</style>
      <svg
        viewBox="0 0 1440 900"
        preserveAspectRatio="xMidYMid slice"
        className="w-full h-full"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="lg-teal" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2DD4BF" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#2DD4BF" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="lg-violet" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#A78BFA" stopOpacity="0.10" />
            <stop offset="100%" stopColor="#A78BFA" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Subtle horizontal grid */}
        {[220, 370, 520, 670].map((y) => (
          <line
            key={y}
            x1="0"
            y1={y}
            x2="1440"
            y2={y}
            stroke="rgba(255,255,255,0.03)"
            strokeWidth="1"
          />
        ))}

        {/* Scrolling trend lines: each path's first and last point share a y value,
            so tiling it at x=0 and x=1440 and translating by exactly one tile
            width (1440px) makes the scroll loop with zero seam. */}
        <g
          className="cr-anim cr-marquee-track"
          style={{ animation: 'cr-marquee 42s linear infinite' }}
        >
          {[0, 1].map((tile) => (
            <g key={tile} transform={`translate(${tile * 1440}, 0)`}>
              <path d={`${VIOLET_LINE} L1440,900 L0,900 Z`} fill="url(#lg-violet)" />
              <path
                d={VIOLET_LINE}
                fill="none"
                stroke="#A78BFA"
                strokeWidth="1.5"
                strokeOpacity="0.3"
              />
              <TrendDots dots={VIOLET_DOTS} color="#A78BFA" period={3.4} />
            </g>
          ))}
        </g>

        <g
          className="cr-anim cr-marquee-track"
          style={{ animation: 'cr-marquee 28s linear infinite' }}
        >
          {[0, 1].map((tile) => (
            <g key={tile} transform={`translate(${tile * 1440}, 0)`}>
              <path d={`${TEAL_LINE} L1440,900 L0,900 Z`} fill="url(#lg-teal)" />
              <path
                d={TEAL_LINE}
                fill="none"
                stroke="#2DD4BF"
                strokeWidth="2"
                strokeOpacity="0.65"
              />
              <TrendDots dots={TEAL_DOTS} color="#2DD4BF" period={3} />
            </g>
          ))}
        </g>
      </svg>
    </div>
  )
}

export function LoginPage() {
  const navigate = useNavigate()
  const login = trpc.auth.login.useMutation()
  const signupStatus = trpc.auth.signupStatus.useQuery()
  const selfHost = getDeployment() === 'self_host'
  // Self-hosted: signup is first-owner-only unless the operator opened it, so only offer the link
  // when it leads somewhere useful. Cloud keeps the trial CTA.
  const signupLink = selfHost
    ? signupStatus.data?.ownerSetup
      ? { prompt: 'First time here? ', label: 'Create the owner account' }
      : signupStatus.data?.mode === 'open'
        ? { prompt: "Don't have an account? ", label: 'Create one' }
        : null
    : { prompt: "Don't have an account? ", label: 'Start free trial' }
  const [step, setStep] = useState<'identifier' | 'credential'>('identifier')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ssoBlocked, setSsoBlocked] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [sso, setSso] = useState<SsoDiscovery | null>(null)

  const handleIdentifierSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setDiscovering(true)
    try {
      const discovered = await discoverSso(email)
      setSso(discovered)
      setStep('credential')
    } finally {
      setDiscovering(false)
    }
  }

  const handleCredentialSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setSsoBlocked(false)
    try {
      const data = await login.mutateAsync({ email, password })
      setToken(data.accessToken)
      track('login_succeeded', { method: 'password' })
      navigate('/')
    } catch (err) {
      if (err instanceof TRPCClientError && err.data?.code === 'FORBIDDEN') {
        setSsoBlocked(true)
        setError(err.message || 'Your organization requires SSO to sign in.')
      } else {
        setError(err instanceof Error ? err.message : 'Unable to sign in.')
      }
    }
  }

  const handleChangeEmail = () => {
    setStep('identifier')
    setSso(null)
    setError(null)
    setSsoBlocked(false)
  }

  return (
    <div className="min-h-screen bg-background relative flex items-center justify-center p-4 overflow-hidden">
      {/* Animated chart */}
      <LoginChartBackground />

      {/* Soft vignette so card reads cleanly */}
      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse 60% 70% at 50% 50%, transparent 30%, #0C0C15 100%)',
        }}
      />

      <div className="w-full max-w-[360px] relative z-10">
        <AuthLogo />

        <div className="bg-card/80 backdrop-blur-md border border-border rounded-xl p-7 shadow-2xl shadow-black/60">
          <h2 className="text-sm font-semibold text-foreground mb-0.5">Welcome back</h2>
          <p className="text-[11px] text-muted-foreground mb-6">
            Sign in to continue to your workspace.
          </p>

          {step === 'identifier' && (
            <form onSubmit={handleIdentifierSubmit} className="space-y-3">
              {/* Email */}
              <div>
                <label
                  htmlFor="email"
                  className="block text-[11px] font-medium text-muted-foreground mb-1.5"
                >
                  Work email
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                  autoComplete="email"
                  required
                  className={inputCls}
                />
              </div>

              <button
                type="submit"
                disabled={discovering}
                className={cn(
                  'w-full bg-primary text-primary-foreground text-xs font-semibold py-2.5 rounded-md',
                  'hover:opacity-90 transition-opacity disabled:opacity-60',
                  'flex items-center justify-center gap-2',
                )}
              >
                {discovering ? (
                  <>
                    <AuthSpinner />
                    Checking…
                  </>
                ) : (
                  'Continue'
                )}
              </button>
            </form>
          )}

          {step === 'credential' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between mb-1">
                <p className="text-[11px] text-muted-foreground truncate" title={email}>
                  {email}
                </p>
                <button
                  type="button"
                  onClick={handleChangeEmail}
                  className="text-[11px] text-primary hover:opacity-70 transition-opacity shrink-0 ml-2"
                >
                  Change
                </button>
              </div>

              {sso && (
                <>
                  <a
                    href={sso.startUrl}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-md border border-border text-xs font-semibold text-foreground hover:border-border/80 hover:bg-muted/30 transition-colors"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    Continue with SSO
                  </a>

                  <div className="flex items-center gap-2">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
                      or
                    </span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                </>
              )}

              <form onSubmit={handleCredentialSubmit} className="space-y-3">
                {/* Password */}
                <div>
                  <div className="relative">
                    <input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="Enter your password"
                      autoComplete="current-password"
                      required
                      className={cn(inputCls, 'pr-10')}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                      tabIndex={-1}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? (
                        <EyeOff className="w-3.5 h-3.5" />
                      ) : (
                        <Eye className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label
                      htmlFor="password"
                      className="text-[11px] font-medium text-muted-foreground"
                    >
                      Password
                    </label>
                    <button
                      type="button"
                      className="text-[11px] text-primary hover:opacity-70 transition-opacity"
                    >
                      Forgot password?
                    </button>
                  </div>
                </div>

                {error && (
                  <p
                    className={cn(
                      'text-[11px] font-medium',
                      ssoBlocked ? 'text-amber-400' : 'text-red-400',
                    )}
                  >
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={login.isPending}
                  className={cn(
                    'w-full bg-primary text-primary-foreground text-xs font-semibold py-2.5 rounded-md',
                    'hover:opacity-90 transition-opacity disabled:opacity-60',
                    'flex items-center justify-center gap-2',
                  )}
                >
                  {login.isPending ? (
                    <>
                      <AuthSpinner />
                      Signing in…
                    </>
                  ) : (
                    'Sign in'
                  )}
                </button>
              </form>
            </div>
          )}
        </div>

        {signupLink && (
          <p className="text-center text-[11px] text-muted-foreground mt-5">
            {signupLink.prompt}
            <Link
              to="/signup"
              className="text-primary hover:opacity-80 transition-opacity font-medium"
            >
              {signupLink.label}
            </Link>
          </p>
        )}
      </div>
    </div>
  )
}
