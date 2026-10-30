/**
 * Clear an admin's login lockout (3 failed password/TOTP/recovery attempts locks
 * the account indefinitely; there is no auto-expiry, this CLI is the only way out).
 *
 * Usage:
 *   pnpm --filter @clickroom/db admin:unlock -- --email <e> --yes
 */
import os from 'node:os'
import { AdminAuditService } from './admin-audit.service.js'
import { prisma } from './client.js'

interface CliArgs {
  email: string
  confirmed: boolean
}

function printUsage(): void {
  console.error('Usage: pnpm --filter @clickroom/db admin:unlock -- --email <e> --yes')
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
    console.error('Error: --yes is required to confirm this action')
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

  await prisma.adminUser.update({
    where: { id: existing.id },
    data: { failedLoginCount: 0, loginLockedAt: null },
  })

  await new AdminAuditService(prisma).record(existing.id, 'admin.unlock', {
    after: { actor: 'cli', operator: os.userInfo().username },
  })

  console.log(`${args.email} unlocked.`)
  process.exit(0)
}

main().catch((err) => {
  console.error('admin:unlock failed:', err instanceof Error ? (err.stack ?? err.message) : err)
  process.exit(1)
})
