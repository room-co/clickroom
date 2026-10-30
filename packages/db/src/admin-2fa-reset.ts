/**
 * Clear an admin's TOTP enrollment and recovery codes, forcing re-enrollment on
 * their next successful login.
 *
 * Usage:
 *   pnpm --filter @clickroom/db admin:2fa:reset -- --email <e> --yes
 *
 * Separate from admin:unlock — resetting 2FA does not clear a login lockout, and unlocking an
 * account does not reset its 2FA enrollment. Different blast radii, different commands.
 */
import os from 'node:os'
import { AdminAuditService } from './admin-audit.service.js'
import { prisma } from './client.js'

interface CliArgs {
  email: string
  confirmed: boolean
}

function printUsage(): void {
  console.error('Usage: pnpm --filter @clickroom/db admin:2fa:reset -- --email <e> --yes')
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { confirmed: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--email') args.email = argv[++i]
    else if (arg === '--yes') args.confirmed = true
    else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${arg}`)
      printUsage()
      process.exit(2)
    }
  }
  if (!args.email) {
    console.error('Error: --email is required')
    printUsage()
    process.exit(2)
  }
  if (!args.confirmed) {
    console.error('Error: --yes is required to confirm this destructive action')
    printUsage()
    process.exit(2)
  }
  return { email: args.email.toLowerCase(), confirmed: true }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const existing = await prisma.adminUser.findUnique({ where: { email: args.email } })
  if (!existing) {
    console.error(`No AdminUser found for ${args.email}.`)
    process.exit(1)
  }

  await prisma.$transaction([
    prisma.adminUser.update({
      where: { id: existing.id },
      data: {
        totpSecretEnc: null,
        totpPendingEnc: null,
        totpEnrolledAt: null,
        totpLastStep: null,
      },
    }),
    prisma.adminRecoveryCode.deleteMany({ where: { adminUserId: existing.id } }),
  ])

  await new AdminAuditService(prisma).record(existing.id, 'admin.2fa.reset', {
    after: { actor: 'cli', operator: os.userInfo().username },
  })

  console.log(`2FA reset for ${args.email}.`)
  console.log('Next sign-in will force re-enrollment.')
  process.exit(0)
}

main().catch((err) => {
  console.error('admin:2fa:reset failed:', err instanceof Error ? (err.stack ?? err.message) : err)
  process.exit(1)
})
