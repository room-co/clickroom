import crypto from 'node:crypto'
import type { EncryptedBlob } from './types.js'

const ALGORITHM = 'aes-256-gcm' as const

// Fail fast at first use rather than silently encrypting/decrypting with an
// undefined key (which would throw deep inside node:crypto with a confusing
// message) or, worse, silently no-op'ing and leaking a plaintext key.
function getEncryptionKey(): Buffer {
  const key = process.env.AI_ENCRYPTION_KEY
  if (!key) throw new Error('AI_ENCRYPTION_KEY not set')
  return Buffer.from(key, 'hex')
}

export function encryptApiKey(apiKey: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const blob: EncryptedBlob = {
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
  }
  return JSON.stringify(blob)
}

export function decryptApiKey(encrypted: string): string {
  const blob = JSON.parse(encrypted) as EncryptedBlob
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getEncryptionKey(),
    Buffer.from(blob.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'))
  return (
    decipher.update(Buffer.from(blob.ciphertext, 'base64')).toString('utf8') +
    decipher.final('utf8')
  )
}
