import { prisma } from './client.js'
import { resetUserPassword } from './user-reset-password.js'

function usage(): never {
  console.error('Usage: pnpm user:reset-password --email <e> [--password <new-password>]')
  process.exit(2)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  let email: string | undefined
  let password: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--email') email = argv[++i]
    else if (arg === '--password') password = argv[++i]
    else usage()
  }
  if (!email) usage()

  const result = await resetUserPassword(prisma, { email, password })
  if (result.status === 'not_found') {
    console.error(`No user found for ${email}.`)
    process.exit(1)
  }
  if (result.status === 'sso_only') {
    console.error(`${email} signs in with SSO and has no password to reset.`)
    process.exit(1)
  }
  console.log(`Password reset for ${email}; ${result.sessionsRevoked} session(s) signed out.`)
  if (!password) {
    console.log('')
    console.log(`  New password: ${result.password}`)
    console.log('')
    console.log('Shown once. Share it securely and ask the user to change it after signing in.')
  }
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('user:reset-password failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
