import { randomBytes } from 'node:crypto'
import { McpAuthCodeStore } from '@clickroom/trpc-router/mcp/oauth/code-store.js'
import { Redis } from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380')
const store = new McpAuthCodeStore(redis)

afterAll(async () => {
  await redis.quit()
})

function mint(overrides?: Partial<Parameters<McpAuthCodeStore['mintCode']>[0]>) {
  return store.mintCode({
    clientId: `mcp_client_${randomBytes(4).toString('hex')}`,
    userId: 'user-1',
    orgId: 'org-1',
    projectId: 'project-1',
    redirectUri: 'http://127.0.0.1:9999/callback',
    codeChallenge: 'challenge-abc',
    ...overrides,
  })
}

describe('McpAuthCodeStore', () => {
  it('peekChallenge returns the stored code_challenge without consuming', async () => {
    const code = await mint({ codeChallenge: 'peek-me' })
    await expect(store.peekChallenge(code)).resolves.toBe('peek-me')
    // Still consumable after peeking.
    await expect(store.consumeCode(code)).resolves.not.toBeNull()
  })

  it('peekChallenge returns empty string for an unknown code', async () => {
    await expect(store.peekChallenge('not-a-real-code')).resolves.toBe('')
  })

  it('consumeCode returns the full payload once, then null on replay', async () => {
    const code = await mint({
      clientId: 'mcp_client_replay',
      userId: 'user-2',
      orgId: 'org-2',
      projectId: 'proj-2',
    })

    const first = await store.consumeCode(code)
    expect(first).toMatchObject({
      clientId: 'mcp_client_replay',
      userId: 'user-2',
      orgId: 'org-2',
      projectId: 'proj-2',
      redirectUri: 'http://127.0.0.1:9999/callback',
      codeChallenge: 'challenge-abc',
    })

    await expect(store.consumeCode(code)).resolves.toBeNull()
  })

  it('consumeCode returns null for an unknown code', async () => {
    await expect(store.consumeCode('totally-unknown-code')).resolves.toBeNull()
  })
})
