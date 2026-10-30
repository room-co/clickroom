import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { AdminLogo } from '@/components/AdminLogo'
import { QrCode } from '@/components/QrCode'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { setAccessToken } from '@/lib/auth-store'
import { trpc } from '@/lib/trpc'
import type { TwoFactorChallengeState } from './login'

interface EnrollmentSecret {
  secretBase32: string
  otpauthUri: string
}

/** Kicks off `enrollTotpStart` exactly once per challenge (guarded against React 18 dev
 * double-invoke), so the pending TOTP secret isn't regenerated on every render. */
function useEnrollmentStart(challengeToken: string) {
  const [secret, setSecret] = useState<EnrollmentSecret | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const started = useRef(false)
  const enrollStart = trpc.adminAuth.enrollTotpStart.useMutation()
  const { mutateAsync: startEnrollment } = enrollStart

  useEffect(() => {
    if (started.current) return
    started.current = true
    startEnrollment({ challengeToken })
      .then(setSecret)
      .catch(() => setStartError('Could not start enrollment. Please sign in again.'))
  }, [challengeToken, startEnrollment])

  return { secret, startError }
}

function EnrollStep({
  secret,
  code,
  onCodeChange,
  onSubmit,
  pending,
  error,
}: {
  secret: EnrollmentSecret
  code: string
  onCodeChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  pending: boolean
  error: string | null
}) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex justify-center">
        <QrCode value={secret.otpauthUri} />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-xs text-muted-foreground">Or enter this key manually</p>
        <div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2 font-mono text-sm">
          <span className="flex-1 break-all">{secret.secretBase32}</span>
          <button
            type="button"
            className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => navigator.clipboard.writeText(secret.secretBase32)}
          >
            Copy
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="enroll-code">Authenticator code</Label>
        <Input
          id="enroll-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          placeholder="000000"
          className="text-center font-mono tracking-[0.5em]"
          value={code}
          onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
          autoFocus
          required
        />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Confirming…' : 'Confirm'}
      </Button>
    </form>
  )
}

function RecoveryCodesStep({
  codes,
  acknowledged,
  onAcknowledgeChange,
  onContinue,
}: {
  codes: string[]
  acknowledged: boolean
  onAcknowledgeChange: (checked: boolean) => void
  onContinue: () => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Save these recovery codes somewhere safe. Each can be used once if you lose access to your
        authenticator app — they will not be shown again.
      </p>
      <div className="grid grid-cols-1 gap-1 rounded-md border bg-muted p-3 font-mono text-sm sm:grid-cols-2">
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <div className="flex items-start gap-2 text-sm">
        <Checkbox
          id="recovery-codes-acknowledged"
          checked={acknowledged}
          onCheckedChange={(checked) => onAcknowledgeChange(checked === true)}
        />
        <Label htmlFor="recovery-codes-acknowledged" className="font-normal">
          I have saved these codes.
        </Label>
      </div>
      <Button type="button" disabled={!acknowledged} onClick={onContinue}>
        Continue
      </Button>
    </div>
  )
}

/** `/login/2fa/enroll` — mandatory first-time TOTP setup: QR + base32 secret fallback, confirm
 * code, then one-time recovery codes gated behind an explicit acknowledgment before the admin can
 * proceed (`Checkbox` from `components/ui/checkbox.tsx`, ported for this app in. */
export function LoginTwoFactorEnrollPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const challenge = location.state as TwoFactorChallengeState | null
  const [code, setCode] = useState('')
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [pendingAccessToken, setPendingAccessToken] = useState<string | null>(null)

  const enrollConfirm = trpc.adminAuth.enrollTotpConfirm.useMutation()
  const { secret, startError } = useEnrollmentStart(challenge?.challengeToken ?? '')

  if (!challenge?.challengeToken) {
    return <Navigate to="/login" replace />
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setConfirmError(null)
    try {
      const challengeToken = challenge?.challengeToken
      if (!challengeToken) return
      const result = await enrollConfirm.mutateAsync({ challengeToken, code })
      setRecoveryCodes(result.recoveryCodes)
      setPendingAccessToken(result.accessToken)
    } catch {
      setConfirmError('Invalid code. Please try again.')
    }
  }

  function onContinue() {
    if (!pendingAccessToken) return
    setAccessToken(pendingAccessToken)
    navigate(challenge?.from ?? '/', { replace: true })
  }

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center bg-background p-4">
      <AdminLogo />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center text-lg">Set up two-factor authentication</CardTitle>
          <CardDescription className="text-center">
            Required before you can access the admin console.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {recoveryCodes ? (
            <RecoveryCodesStep
              codes={recoveryCodes}
              acknowledged={acknowledged}
              onAcknowledgeChange={setAcknowledged}
              onContinue={onContinue}
            />
          ) : startError ? (
            <p className="text-sm text-destructive">{startError}</p>
          ) : secret ? (
            <EnrollStep
              secret={secret}
              code={code}
              onCodeChange={setCode}
              onSubmit={onSubmit}
              pending={enrollConfirm.isPending}
              error={confirmError}
            />
          ) : (
            <p className="text-center text-sm text-muted-foreground">Preparing enrollment…</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
