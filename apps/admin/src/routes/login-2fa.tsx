import { TRPCClientError } from '@trpc/client'
import { type FormEvent, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { AdminLogo } from '@/components/AdminLogo'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { setAccessToken } from '@/lib/auth-store'
import { trpc } from '@/lib/trpc'
import type { TwoFactorChallengeState } from './login'

const GENERIC_ERROR = 'Invalid code. Please try again.'
const RATE_LIMIT_ERROR = 'Too many attempts, try again later.'

function errorMessage(err: unknown): string {
  if (err instanceof TRPCClientError && err.data?.code === 'TOO_MANY_REQUESTS') {
    return RATE_LIMIT_ERROR
  }
  return GENERIC_ERROR
}

/** `/login/2fa` — TOTP code, with a toggle to a recovery code instead. Reads the challenge token
 * from router state only (never a query param) so it doesn't linger in history/logs; a direct
 * visit with no challenge in state bounces back to `/login`. */
export function LoginTwoFactorPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const challenge = location.state as TwoFactorChallengeState | null
  const [useRecovery, setUseRecovery] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const verifyTotp = trpc.adminAuth.verifyTotp.useMutation()
  const verifyRecoveryCode = trpc.adminAuth.verifyRecoveryCode.useMutation()
  const pending = verifyTotp.isPending || verifyRecoveryCode.isPending

  if (!challenge?.challengeToken) {
    return <Navigate to="/login" replace />
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    try {
      const challengeToken = challenge?.challengeToken
      if (!challengeToken) return
      const result = useRecovery
        ? await verifyRecoveryCode.mutateAsync({ challengeToken, code })
        : await verifyTotp.mutateAsync({ challengeToken, code })
      setAccessToken(result.accessToken)
      navigate(challenge?.from ?? '/', { replace: true })
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center bg-background p-4">
      <AdminLogo />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center text-lg">Two-factor authentication</CardTitle>
          <CardDescription className="text-center">
            {useRecovery
              ? 'Enter one of your recovery codes.'
              : 'Enter the code from your authenticator app.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {useRecovery ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="recovery-code">Recovery code</Label>
                <Input
                  id="recovery-code"
                  autoComplete="off"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                />
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="totp-code">Authenticator code</Label>
                <Input
                  id="totp-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  placeholder="000000"
                  className="text-center font-mono tracking-[0.5em]"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoFocus
                  required
                />
              </div>
            )}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" disabled={pending}>
              {pending ? 'Verifying…' : 'Verify'}
            </Button>
            <button
              type="button"
              className="text-center text-sm text-muted-foreground hover:text-foreground"
              onClick={() => {
                setUseRecovery((value) => !value)
                setCode('')
                setError(null)
              }}
            >
              {useRecovery ? 'Use an authenticator code instead' : 'Use a recovery code instead'}
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
