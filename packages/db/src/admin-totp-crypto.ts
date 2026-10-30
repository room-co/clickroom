import { openJson, sealJson } from '@clickroom/auth'

/** Envelope-encrypt a TOTP base32 secret for storage in AdminUser.totpSecretEnc/totpPendingEnc. */
export function encryptTotpSecret(base32: string): string {
  return sealJson(base32)
}

/**
 * Decrypt a stored TOTP secret. Not total: `openJson` throws on a malformed blob or a
 * GCM auth-tag mismatch, so we catch and return null rather than letting a corrupted
 * envelope propagate or silently fall back to treating the ciphertext as raw.
 */
export function decryptTotpSecret(stored: string): string | null {
  try {
    return openJson<string>(stored)
  } catch {
    return null
  }
}
