/**
 * Provision an internal AdminUser.
 *
 * Usage:
 *   pnpm --filter @clickroom/db admin:create -- --email <e> [--name "Full Name"] [--rotate]
 *
 * The password goes where `ADMIN_PASSWORD_SINK` says: `ssm` (cloud default,
 * SecureString; never echoed), `stdout` (self_host default, printed once) or `env`
 * (uses CLICKROOM_ADMIN_PASSWORD, prints nothing). See admin-provision.ts.
 * Self-host: docker compose exec api pnpm admin:create --email <e>
 */

import { provisionAdmin } from './admin-provision.js'
import { prisma } from './client.js'
import { resolveAdminPasswordSink } from './deployment.js'
import { adminPasswordParameterName, putAdminPasswordParameter } from './ssm-client.js'

interface CliArgs {
  email: string
  name?: string
  rotate: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { rotate: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--email') args.email = argv[++i]
    else if (arg === '--name') args.name = argv[++i]
    else if (arg === '--rotate') args.rotate = true
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
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email)) {
    console.error(`Error: invalid email: ${args.email}`)
    process.exit(2)
  }
  return { email: args.email.toLowerCase(), name: args.name, rotate: args.rotate ?? false }
}

function printUsage(): void {
  console.error(
    'Usage: pnpm --filter @clickroom/db admin:create -- --email <e> [--name "Full Name"] [--rotate]',
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const sink = resolveAdminPasswordSink()
  if (sink === 'ssm' && process.env.NODE_ENV === 'production' && !process.env.AWS_REGION) {
    console.error('Error: AWS_REGION must be set for ADMIN_PASSWORD_SINK=ssm in production.')
    process.exit(1)
  }

  let result: Awaited<ReturnType<typeof provisionAdmin>>
  try {
    result = await provisionAdmin(
      prisma,
      {
        email: args.email,
        name: args.name,
        rotate: args.rotate,
        sink,
        envPassword: process.env.CLICKROOM_ADMIN_PASSWORD,
        actor: 'cli',
      },
      { log: (line) => console.log(line), putSsm: putAdminPasswordParameter },
    )
  } catch (err) {
    // The DB write precedes delivery, so a sink failure is recoverable with --rotate.
    console.error('admin:create failed:', err instanceof Error ? err.message : String(err))
    console.error(
      `If the row was written, recover with: pnpm admin:create -- --email ${args.email} --rotate`,
    )
    process.exit(1)
  }
  if (result.status === 'exists') {
    console.error(
      `AdminUser already exists for ${args.email}. Use --rotate to issue a new password.`,
    )
    process.exit(1)
  }
  process.exit(0)
}

// Surface the canonical parameter name for tooling that wants to derive it without invoking AWS.
export { adminPasswordParameterName }

main().catch((err) => {
  console.error('admin:create failed:', err instanceof Error ? (err.stack ?? err.message) : err)
  process.exit(1)
})
