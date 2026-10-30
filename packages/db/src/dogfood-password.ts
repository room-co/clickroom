import { randomBytes } from 'node:crypto'

export interface DogfoodPassword {
  password: string
  /** True when no DOGFOOD_ADMIN_PASSWORD was supplied and one was generated (print it once). */
  generated: boolean
}

/**
 * The dogfood admin password is never a committed literal, in any mode: it comes from
 * `DOGFOOD_ADMIN_PASSWORD`, or is generated here (and printed once by the caller).
 */
export function resolveDogfoodPassword(
  env: Record<string, string | undefined> = process.env,
  generate: () => string = () => randomBytes(18).toString('base64url'),
): DogfoodPassword {
  const supplied = env.DOGFOOD_ADMIN_PASSWORD?.trim()
  if (supplied) return { password: supplied, generated: false }
  return { password: generate(), generated: true }
}
