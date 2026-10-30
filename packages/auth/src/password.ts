import * as argon2 from 'argon2'

/** Argon2id hash of a plaintext password for storage. */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id })
}

/**
 * Constant-time verification of a plaintext password against its stored hash.
 * Note the argument order: the stored hash comes FIRST.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password)
  } catch {
    return false
  }
}
