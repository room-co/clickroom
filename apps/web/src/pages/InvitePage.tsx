import { type FormEvent, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { AuthGrid, AuthLogo, AuthSpinner, PasswordStrength } from '@/components/auth-ui'
import { SkeletonCard } from '@/components/skeletons'
import { setToken } from '@/lib/auth'
import { trpc } from '@/lib/trpc'
import { cn } from '@/lib/utils'

const inputCls =
  'w-full bg-muted/30 border border-border rounded-md text-xs px-3 py-2.5 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/60 focus:border-primary/40 transition-colors'

const disabledInputCls = cn(inputCls, 'opacity-60 cursor-not-allowed')

export function InvitePage() {
  const { token = '' } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const inviteQuery = trpc.auth.getInvite.useQuery({ token }, { retry: false })
  const acceptInvite = trpc.auth.acceptInvite.useMutation()

  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name || !password) {
      setError('Please fill in all fields.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    setError(null)
    try {
      const data = await acceptInvite.mutateAsync({ token, name, password })
      setToken(data.accessToken)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to accept invite.')
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <AuthGrid />
      <div className="w-full max-w-[380px] relative">
        <AuthLogo />

        <div className="bg-card border border-border rounded-xl p-7 shadow-2xl shadow-black/40">
          {inviteQuery.isPending && (
            <SkeletonCard lines={5} className="border-0 bg-transparent p-0" />
          )}

          {inviteQuery.isError && (
            <div className="py-2 text-center space-y-3">
              <h2 className="text-sm font-semibold text-foreground">Invite not found</h2>
              <p className="text-[11px] text-muted-foreground">
                This invite link is invalid or has expired.
              </p>
              <Link
                to="/login"
                className="inline-block text-[11px] text-primary hover:opacity-80 transition-opacity font-medium"
              >
                Back to sign in
              </Link>
            </div>
          )}

          {inviteQuery.data && (
            <>
              <h2 className="text-sm font-semibold text-foreground mb-0.5">
                Join {inviteQuery.data.orgName}
              </h2>
              <p className="text-[11px] text-muted-foreground mb-6">
                Create your account to accept the invite.
              </p>

              <form onSubmit={handleSubmit} className="space-y-3">
                <div>
                  <label
                    htmlFor="invite-email"
                    className="block text-[11px] font-medium text-muted-foreground mb-1.5"
                  >
                    Email
                  </label>
                  <input
                    id="invite-email"
                    type="email"
                    value={inviteQuery.data.email}
                    disabled
                    className={disabledInputCls}
                  />
                </div>

                <div>
                  <label
                    htmlFor="invite-name"
                    className="block text-[11px] font-medium text-muted-foreground mb-1.5"
                  >
                    Full name
                  </label>
                  <input
                    id="invite-name"
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
                    htmlFor="invite-password"
                    className="block text-[11px] font-medium text-muted-foreground mb-1.5"
                  >
                    Password
                  </label>
                  <input
                    id="invite-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="••••••••••"
                    autoComplete="new-password"
                    className={inputCls}
                  />
                  <PasswordStrength password={password} />
                </div>

                {error && <p className="text-[11px] text-red-400 font-medium">{error}</p>}

                <button
                  type="submit"
                  disabled={acceptInvite.isPending}
                  className="w-full bg-primary text-primary-foreground text-xs font-semibold py-2.5 rounded-md hover:opacity-90 transition-opacity disabled:opacity-60 flex items-center justify-center gap-2"
                >
                  {acceptInvite.isPending ? (
                    <>
                      <AuthSpinner />
                      Joining…
                    </>
                  ) : (
                    'Accept invite'
                  )}
                </button>
              </form>
            </>
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
