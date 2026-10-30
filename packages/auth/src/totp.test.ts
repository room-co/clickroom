import { describe, expect, it } from 'vitest'
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  totpCodeForStep,
  totpStep,
  verifyTotp,
} from './totp.js'

// ---------------------------------------------------------------------------
// RFC 6238 Appendix B publishes test vectors for the shared 20-byte ASCII
// secret "12345678901234567890" (the SHA1 case), keyed by unix time rather
// than by step directly. `totpCodeForStep(secret, step)` takes a step
// number, and `totpStep(atMs)` derives a step from a fixed epoch millis
// value with no implicit `Date.now()` dependency — both accept fixed input,
// so the RFC vectors ARE directly usable here without any change to
// totp.ts's API. (Had `totpStep`/`totpCodeForStep` only read `Date.now()`
// internally with no override, we'd have fallen back to secret-generation +
// encode/verify round-trips instead — that fallback wasn't needed.)
//
// totp.ts's secret format is base32 (RFC 4226/6238's TOTP secrets are
// typically distributed as base32), so the RFC's raw ASCII test key is
// base32-encoded here before being handed to totpCodeForStep — this is
// exactly the same transform generateTotpSecret()/buildOtpauthUri() assume
// for every real secret in this codebase.
// ---------------------------------------------------------------------------

const RFC_6238_SECRET_ASCII = '12345678901234567890' // SHA1 test key from RFC 6238 Appendix B
const RFC_6238_SECRET_B32 = base32Encode(Buffer.from(RFC_6238_SECRET_ASCII, 'ascii'))

// [unix time (s), expected step, expected 6-digit truncation of the 8-digit RFC code]
// RFC 6238 Appendix B lists 8-digit codes; totp.ts is a fixed 6-digit implementation
// (CODE_DIGITS = 6), so the low-order 6 digits of each 8-digit RFC vector are the
// correct 6-digit expectation (mod 10^6 truncation is exactly what a 6-digit TOTP does).
const RFC_6238_VECTORS: Array<{ atSeconds: number; step: number; code8: string }> = [
  { atSeconds: 59, step: 1, code8: '94287082' },
  { atSeconds: 1111111109, step: 37037036, code8: '07081804' },
  { atSeconds: 1111111111, step: 37037037, code8: '14050471' },
  { atSeconds: 1234567890, step: 41152263, code8: '89005924' },
  { atSeconds: 2000000000, step: 66666666, code8: '69279037' },
]

describe('totp RFC 4226/6238 vectors', () => {
  it.each(RFC_6238_VECTORS)('derives the correct step for unix time $atSeconds', ({
    atSeconds,
    step,
  }) => {
    expect(totpStep(atSeconds * 1000)).toBe(step)
  })

  it.each(
    RFC_6238_VECTORS,
  )('totpCodeForStep($step) matches the low 6 digits of the RFC 8-digit code', ({
    step,
    code8,
  }) => {
    const expected6 = code8.slice(-6)
    expect(totpCodeForStep(RFC_6238_SECRET_B32, step)).toBe(expected6)
  })

  it.each(
    RFC_6238_VECTORS,
  )('verifyTotp accepts the correct code at the exact atMs for step $step', ({
    atSeconds,
    step,
    code8,
  }) => {
    const expected6 = code8.slice(-6)
    const result = verifyTotp(RFC_6238_SECRET_B32, expected6, { atMs: atSeconds * 1000 })
    expect(result).toEqual({ ok: true, step })
  })
})

describe('totp base32 round trip', () => {
  it('base32Decode(base32Encode(buf)) recovers the original bytes', () => {
    const buf = Buffer.from('some arbitrary secret bytes 1234', 'utf8')
    expect(base32Decode(base32Encode(buf))).toEqual(buf)
  })

  it('generateTotpSecret produces a decodable base32 string', () => {
    const secret = generateTotpSecret()
    expect(secret).toMatch(/^[A-Z2-7]+$/)
    expect(base32Decode(secret).length).toBe(20)
  })
})

describe('verifyTotp window and rejection behavior', () => {
  it('accepts a code one step in the past within the default window', () => {
    const secret = generateTotpSecret()
    const now = totpStep()
    const pastCode = totpCodeForStep(secret, now - 1)
    expect(verifyTotp(secret, pastCode)).toEqual({ ok: true, step: now - 1 })
  })

  it('accepts a code one step in the future within the default window', () => {
    const secret = generateTotpSecret()
    const now = totpStep()
    const futureCode = totpCodeForStep(secret, now + 1)
    expect(verifyTotp(secret, futureCode)).toEqual({ ok: true, step: now + 1 })
  })

  it('rejects a code two steps outside the default ±1 window', () => {
    const secret = generateTotpSecret()
    const now = totpStep()
    const farCode = totpCodeForStep(secret, now + 2)
    expect(verifyTotp(secret, farCode)).toEqual({ ok: false })
  })

  it('rejects malformed input that does not match 6 digits', () => {
    const secret = generateTotpSecret()
    expect(verifyTotp(secret, '12345')).toEqual({ ok: false })
    expect(verifyTotp(secret, 'abcdef')).toEqual({ ok: false })
    expect(verifyTotp(secret, '1234567')).toEqual({ ok: false })
  })

  it('rejects a well-formed but wrong code', () => {
    const secret = generateTotpSecret()
    const now = totpStep()
    const correct = totpCodeForStep(secret, now)
    const wrong = correct === '000000' ? '000001' : '000000'
    expect(verifyTotp(secret, wrong)).toEqual({ ok: false })
  })

  it('honors a custom window size', () => {
    const secret = generateTotpSecret()
    const now = totpStep()
    const twoAway = totpCodeForStep(secret, now + 2)
    expect(verifyTotp(secret, twoAway, { window: 1 })).toEqual({ ok: false })
    expect(verifyTotp(secret, twoAway, { window: 2 })).toEqual({ ok: true, step: now + 2 })
  })
})

describe('buildOtpauthUri', () => {
  it('embeds secret, issuer, and account in a valid otpauth URI', () => {
    const uri = buildOtpauthUri({
      secret: 'JBSWY3DPEHPK3PXP',
      account: 'admin@clickroom.co',
      issuer: 'Clickroom Admin',
    })
    expect(uri.startsWith('otpauth://totp/')).toBe(true)
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP')
    expect(uri).toContain(encodeURIComponent('Clickroom Admin'))
    expect(uri).toContain(encodeURIComponent('admin@clickroom.co'))
    expect(uri).toContain('algorithm=SHA1')
    expect(uri).toContain('digits=6')
    expect(uri).toContain('period=30')
  })
})
