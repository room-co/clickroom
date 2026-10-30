/**
 * Reset a tenant user's password without a mailer.
 *
 * Usage:
 *   docker compose exec api pnpm user:reset-password --email <e> [--password <p>]
 *
 * Sets a new password (a generated one unless `--password` is given), signs the user out
 * everywhere (deletes their sessions) and prints the password once. There is no email sender
 * in this codebase and no forced-change flag in the schema, so the operator must hand the
 * password over out-of-band and the user should change it after signing in.
 */
import { hashPassword } from '@clickroom/auth'
import type { PrismaClient } from '@prisma/client'
import { generatePassword } from './admin-provision.js'

export const MIN_USER_PASSWORD_LENGTH = 8

export type ResetPasswordResult =
  | { status: 'reset'; userId: string; password: string; sessionsRevoked: number }
  | { status: 'not_found' }
  | { status: 'sso_only'; userId: string }

export async function resetUserPassword(
  prisma: PrismaClient,
  input: { email: string; password?: string },
): Promise<ResetPasswordResult> {
  const email = input.email.trim().toLowerCase()
  if (input.password !== undefined && input.password.length < MIN_USER_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_USER_PASSWORD_LENGTH} characters.`)
  }
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) return { status: 'not_found' }
  // SSO-only accounts authenticate at the IdP; giving them a password would open a side door
  // around an SSO-enforced org.
  if (user.passwordHash == null) return { status: 'sso_only', userId: user.id }

  const password = input.password ?? generatePassword()
  const passwordHash = await hashPassword(password)
  const [, revoked] = await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
    prisma.session.deleteMany({ where: { userId: user.id } }),
  ])
  return { status: 'reset', userId: user.id, password, sessionsRevoked: revoked.count }
}
