import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const STEP_SECONDS = 30
const CODE_DIGITS = 6
const CODE_PATTERN = /^\d{6}$/

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f]
      bits -= 5
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f]
  }
  return output
}

export function base32Decode(s: string): Buffer {
  const cleaned = s.toUpperCase().replace(/=+$/, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function totpStep(atMs = Date.now()): number {
  return Math.floor(atMs / 1000 / STEP_SECONDS)
}

export function totpCodeForStep(secret: string, step: number): string {
  const key = base32Decode(secret)
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt.asUintN(64, BigInt(step)))
  const hmac = createHmac('sha1', key).update(counter).digest()
  // RFC 4226 dynamic truncation: low nibble of the last byte selects a 4-byte
  // window, whose top bit is then masked off to keep the result positive.
  const offset = (hmac.at(-1) ?? 0) & 0x0f
  const binCode = hmac.readUInt32BE(offset) & 0x7fffffff
  const code = (binCode % 10 ** CODE_DIGITS).toString()
  return code.padStart(CODE_DIGITS, '0')
}

export function verifyTotp(
  secret: string,
  code: string,
  opts?: { window?: number; atMs?: number },
): { ok: true; step: number } | { ok: false } {
  if (!CODE_PATTERN.test(code)) return { ok: false }
  const window = opts?.window ?? 1
  const currentStep = totpStep(opts?.atMs)
  const codeBuf = Buffer.from(code, 'utf8')
  for (let delta = -window; delta <= window; delta++) {
    const candidate = totpCodeForStep(secret, currentStep + delta)
    const candidateBuf = Buffer.from(candidate, 'utf8')
    if (timingSafeEqual(codeBuf, candidateBuf)) {
      return { ok: true, step: currentStep + delta }
    }
  }
  return { ok: false }
}

export function buildOtpauthUri(o: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(o.issuer)}:${encodeURIComponent(o.account)}`
  const params = new URLSearchParams({
    secret: o.secret,
    issuer: o.issuer,
    algorithm: 'SHA1',
    digits: String(CODE_DIGITS),
    period: String(STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}
