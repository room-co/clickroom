import { type FormEvent, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { AdminLogo } from '@/components/AdminLogo'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { setAccessToken } from '@/lib/auth-store'
import { trpc } from '@/lib/trpc'

/** State `ProtectedAdminRoute` attaches when it redirects an unauthenticated visit here. */
interface LoginRedirectState {
  from?: string
}

/** State handed forward to `/login/2fa` or `/login/2fa/enroll` — never a query param, so the
 * short-lived challenge JWT never lands in browser history or server access logs. */
export interface TwoFactorChallengeState {
  challengeToken: string
  /** Where to send the admin once 2FA completes — carried through from this page's own redirect state. */
  from?: string
}

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const redirectState = location.state as LoginRedirectState | null
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const login = trpc.adminAuth.login.useMutation()

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    try {
      const result = await login.mutateAsync({ email, password })

      if (result.status === 'signed_in') {
        // Dev-only ADMIN_DEV_DISABLE_2FA bypass path — never returned in production, since TOTP
        // is mandatory. See packages/trpc-router/src/trpc/routers/admin-auth.router.ts `login`.
        setAccessToken(result.accessToken)
        navigate(redirectState?.from ?? '/', { replace: true })
        return
      }

      const challengeState: TwoFactorChallengeState = {
        challengeToken: result.challengeToken,
        from: redirectState?.from,
      }
      navigate(result.status === 'totp_required' ? '/login/2fa' : '/login/2fa/enroll', {
        replace: true,
        state: challengeState,
      })
    } catch {
      setError('Invalid credentials.')
    }
  }

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center bg-background p-4">
      <AdminLogo />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center text-lg">Sign in</CardTitle>
          <CardDescription className="text-center">Sign in to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" disabled={login.isPending}>
              {login.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
