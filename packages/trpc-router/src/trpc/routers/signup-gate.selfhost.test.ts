import type { PrismaClient } from '@clickroom/db'
import { afterEach, describe, expect, it } from 'vitest'
import { assertFirstOwnerInTx, assertSignupsOpen, getSignupStatus } from './signup-gate.js'

// Self-host signup policy. `user.count` is the only DB touch, so
// Prisma is faked; the flag path (cloud) is covered by apps/api's signup-gate.test.ts.
const fakePrisma = (userCount: number) =>
  ({ user: { count: async () => userCount } }) as unknown as PrismaClient

const saved = { dep: process.env.CLICKROOM_DEPLOYMENT, mode: process.env.SIGNUP_MODE }
afterEach(() => {
  for (const [key, value] of [
    ['CLICKROOM_DEPLOYMENT', saved.dep],
    ['SIGNUP_MODE', saved.mode],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function selfHost(mode?: string) {
  process.env.CLICKROOM_DEPLOYMENT = 'self_host'
  if (mode === undefined) delete process.env.SIGNUP_MODE
  else process.env.SIGNUP_MODE = mode
}

describe('self_host SIGNUP_MODE', () => {
  it('open: always allows signup', async () => {
    selfHost('open')
    await expect(assertSignupsOpen(fakePrisma(0), 'a@b.co')).resolves.toBeUndefined()
    await expect(assertSignupsOpen(fakePrisma(5), 'a@b.co')).resolves.toBeUndefined()
  })

  it('first_user_only: allows the first account, rejects afterwards', async () => {
    selfHost('first_user_only')
    await expect(assertSignupsOpen(fakePrisma(0), 'a@b.co')).resolves.toBeUndefined()
    await expect(assertSignupsOpen(fakePrisma(1), 'a@b.co')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('is the default when SIGNUP_MODE is unset', async () => {
    selfHost()
    await expect(assertSignupsOpen(fakePrisma(0), 'a@b.co')).resolves.toBeUndefined()
    await expect(assertSignupsOpen(fakePrisma(2), 'a@b.co')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('closed: rejects even the first account', async () => {
    selfHost('closed')
    await expect(assertSignupsOpen(fakePrisma(0), 'a@b.co')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('an unknown SIGNUP_MODE fails loudly rather than opening signups', async () => {
    selfHost('opne')
    await expect(assertSignupsOpen(fakePrisma(3), 'a@b.co')).rejects.toThrow(/SIGNUP_MODE/)
  })

  it('getSignupStatus flags owner setup only for an empty first_user_only instance', async () => {
    selfHost('first_user_only')
    expect(await getSignupStatus(fakePrisma(0))).toEqual({
      deployment: 'self_host',
      mode: 'first_user_only',
      ownerSetup: true,
    })
    expect((await getSignupStatus(fakePrisma(1))).ownerSetup).toBe(false)
    selfHost('open')
    expect((await getSignupStatus(fakePrisma(0))).ownerSetup).toBe(false)
  })
})

// Emulates Postgres: `pg_advisory_xact_lock` blocks every other transaction that asks
// for it until the holder finishes, and `user.count` sees only committed rows.
function fakeDb() {
  const users: string[] = []
  let holder: Promise<void> = Promise.resolve()
  async function transaction(work: (tx: unknown) => Promise<void>) {
    let release: () => void = () => {}
    let acquired = false
    const tx = {
      $executeRaw: async () => {
        const prev = holder
        holder = new Promise<void>((r) => {
          release = r
        })
        acquired = true
        await prev
        return 0
      },
      user: {
        count: async () => users.length,
        create: async (email: string) => {
          // Yield so an unlocked racer would interleave between count and create.
          await new Promise((r) => setTimeout(r, 5))
          users.push(email)
        },
      },
    }
    try {
      await work(tx)
    } finally {
      if (acquired) release()
    }
  }
  return { users, transaction }
}

describe('first_user_only concurrency', () => {
  it('lets exactly one of two simultaneous first signups through', async () => {
    selfHost('first_user_only')
    const db = fakeDb()
    const signup = (email: string) =>
      db.transaction(async (tx) => {
        await assertFirstOwnerInTx(tx)
        await tx.user.create(email)
      })
    const results = await Promise.allSettled([signup('a@b.co'), signup('c@d.co')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect(db.users).toHaveLength(1)
  })

  it('control: without the in-transaction lock both racers get through', async () => {
    selfHost('first_user_only')
    const db = fakeDb()
    const naive = (email: string) =>
      db.transaction(async (tx) => {
        if ((await tx.user.count()) > 0) throw new Error('owner exists')
        await tx.user.create(email)
      })
    await Promise.all([naive('a@b.co'), naive('c@d.co')])
    expect(db.users).toHaveLength(2)
  })

  it('is a no-op for open mode', async () => {
    selfHost('open')
    const db = fakeDb()
    await db.transaction((tx) => assertFirstOwnerInTx(tx))
  })
})
