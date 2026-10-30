import crypto from 'node:crypto'

const ALGORITHM = 'aes-256-gcm' as const
const KEY_BYTES = 32

// Fail fast at first use rather than silently encrypting/decrypting with an
// undefined or malformed key (which would throw deep inside node:crypto with
// a confusing message) or, worse, silently no-op'ing and leaking a plaintext
// secret.
function getSecretsKey(): Buffer {
  const key = process.env.SSO_SECRETS_KEY
  if (!key) throw new Error('SSO_SECRETS_KEY not set')

  const buf = /^[0-9a-fA-F]{64}$/.test(key) ? Buffer.from(key, 'hex') : Buffer.from(key, 'base64')

  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `SSO_SECRETS_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length}); expected base64 or hex encoding of a 32-byte key`,
    )
  }
  return buf
}

export function sealJson<T>(obj: T): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, getSecretsKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), ciphertext.toString('base64'), tag.toString('base64')].join(':')
}

export function openJson<T>(sealed: string): T {
  const parts = sealed.split(':')
  if (parts.length !== 3) {
    throw new Error('Malformed sealed value: expected iv:ciphertext:tag')
  }
  const [ivB64, ciphertextB64, tagB64] = parts as [string, string, string]
  const decipher = crypto.createDecipheriv(ALGORITHM, getSecretsKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const plaintext =
    decipher.update(Buffer.from(ciphertextB64, 'base64')).toString('utf8') + decipher.final('utf8')
  return JSON.parse(plaintext) as T
}
