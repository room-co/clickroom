/**
 * — provision an internal AdminUser and hand the password to the operator.
 *
 * Shared by the `admin:create` CLI and the optional first-boot bootstrap
 * (`CLICKROOM_ADMIN_EMAIL` / `CLICKROOM_ADMIN_PASSWORD`). Where the password goes is chosen by
 * `ADMIN_PASSWORD_SINK` (see `deployment.ts`):
 *
 *   ssm    - AWS SSM SecureString (cloud default). Never printed.
 *   stdout - printed once to the terminal (self_host default). Run the CLI interactively via
 *            `docker compose exec api pnpm admin:create`; it is not emitted by the boot path.
 *   env    - the operator chose the password via `CLICKROOM_ADMIN_PASSWORD`; nothing is
 *            generated and nothing is printed.
 */
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import { hashPassword } from '@clickroom/auth'
import type { PrismaClient } from '@prisma/client'
import { AdminAuditService } from './admin-audit.service.js'
import { newId } from './client.js'
import type { AdminPasswordSink } from './deployment.js'

export const MIN_ADMIN_PASSWORD_LENGTH = 12

export interface AdminProvisionIo {
  log: (line: string) => void
  /** Writes the password to SSM; returns the parameter name. Injected so tests never touch AWS. */
  putSsm: (email: string, password: string) => Promise<string>
}

export interface AdminProvisionInput {
  email: string
  name?: string
  rotate: boolean
  sink: AdminPasswordSink
  /** Required for the `env` sink; ignored otherwise. */
  envPassword?: string
  /** Audit `after.actor` — `cli` or `bootstrap`. */
  actor: 'cli' | 'bootstrap'
}

export type AdminProvisionResult =
  | { status: 'created' | 'rotated'; adminUserId: string }
  | { status: 'exists'; adminUserId: string }

export function generatePassword(): string {
  // 24 bytes -> 32 base64url chars. URL-safe, no padding.
  return randomBytes(24).toString('base64url')
}

/** The password to set: operator-supplied for the `env` sink, generated otherwise. */
export function choosePassword(sink: AdminPasswordSink, envPassword?: string): string {
  if (sink !== 'env') return generatePassword()
  if (!envPassword) {
    throw new Error('ADMIN_PASSWORD_SINK=env requires CLICKROOM_ADMIN_PASSWORD to be set.')
  }
  if (envPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(
      `CLICKROOM_ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`,
    )
  }
  return envPassword
}

/** Deliver the password through the selected sink. Throws if the sink fails. */
export async function deliverPassword(
  sink: AdminPasswordSink,
  args: { email: string; password: string; verb: string },
  io: AdminProvisionIo,
): Promise<void> {
  const { email, password, verb } = args
  io.log(`AdminUser ${verb} for ${email}.`)
  if (sink === 'ssm') {
    const path = await io.putSsm(email, password)
    io.log(`Password stored at SSM parameter: ${path}`)
    io.log(`Retrieve with: aws ssm get-parameter --name ${path} --with-decryption`)
    return
  }
  if (sink === 'env') {
    io.log('Password was supplied via CLICKROOM_ADMIN_PASSWORD (not printed).')
    return
  }
  io.log('')
  io.log(`  Email:    ${email}`)
  io.log(`  Password: ${password}`)
  io.log('')
  io.log('Shown once - store it now. TOTP is enrolled on first sign-in to the admin console.')
}

/**
 * Create (or rotate) the admin row, then deliver the password. The DB write happens first so a
 * sink failure leaves a recoverable state (re-run with --rotate), exactly like the old SSM path.
 */
export async function provisionAdmin(
  prisma: PrismaClient,
  input: AdminProvisionInput,
  io: AdminProvisionIo,
): Promise<AdminProvisionResult> {
  const existing = await prisma.adminUser.findUnique({ where: { email: input.email } })
  if (existing && !input.rotate) return { status: 'exists', adminUserId: existing.id }

  const password = choosePassword(input.sink, input.envPassword)
  const passwordHash = await hashPassword(password)

  let adminUserId: string
  if (existing) {
    await prisma.adminUser.update({
      where: { id: existing.id },
      data: { passwordHash, ...(input.name ? { fullName: input.name } : {}) },
    })
    adminUserId = existing.id
  } else {
    const created = await prisma.adminUser.create({
      data: { id: newId(), email: input.email, passwordHash, fullName: input.name ?? '' },
    })
    adminUserId = created.id
  }
  const verb = existing ? 'rotated' : 'created'

  await deliverPassword(input.sink, { email: input.email, password, verb }, io)

  await new AdminAuditService(prisma).record(adminUserId, 'admin.create', {
    after: { actor: input.actor, operator: os.userInfo().username, verb },
  })
  return { status: verb, adminUserId }
}

/**
 * First-boot bootstrap: when `CLICKROOM_ADMIN_EMAIL` + `CLICKROOM_ADMIN_PASSWORD` are set and no
 * such admin exists, create it. Idempotent - an existing admin is never touched or rotated, so a
 * restart cannot reset a password the operator changed. Less secure than the interactive CLI
 * (the password sits in the environment), hence opt-in. Always uses the supplied password and
 * never prints it.
 */
export async function ensureBootstrapAdmin(
  prisma: PrismaClient,
  env: Record<string, string | undefined>,
  log: (line: string) => void = console.log,
): Promise<AdminProvisionResult | null> {
  const email = env.CLICKROOM_ADMIN_EMAIL?.trim().toLowerCase()
  const password = env.CLICKROOM_ADMIN_PASSWORD
  if (!email && !password) return null
  if (!email || !password) {
    throw new Error('CLICKROOM_ADMIN_EMAIL and CLICKROOM_ADMIN_PASSWORD must be set together.')
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`CLICKROOM_ADMIN_EMAIL is not a valid email: ${email}`)
  }
  return provisionAdmin(
    prisma,
    { email, rotate: false, sink: 'env', envPassword: password, actor: 'bootstrap' },
    {
      log,
      putSsm: async () => {
        throw new Error('unreachable: bootstrap uses the env sink')
      },
    },
  )
}
