import crypto from 'node:crypto'
import { newId, prisma } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authService, callAs, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

function callerFor(userId: string, orgId: string) {
  return appRouter.createCaller(
    makeCtx({ tokenPayload: { sub: userId, sessionId: 'test', orgId } }),
  )
}

async function makeOrgWithMember(name: string) {
  const s = await authService.signup({
    email: `${name}-admin-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `${name} Org ${suffix}`,
  })
  const adminUserId = s.user.id
  const orgId = s.org!.id
  createdUserIds.push(adminUserId)
  createdOrgIds.push(orgId)

  const memberUser = await prisma.user.create({
    data: {
      id: crypto.randomUUID(),
      email: `${name}-member-${suffix}@test.invalid`,
      passwordHash: 'unused',
    },
  })
  createdUserIds.push(memberUser.id)
  await prisma.orgMembership.create({
    data: { id: newId(), userId: memberUser.id, orgId, role: 'member' },
  })

  return { adminUserId, memberUserId: memberUser.id, orgId }
}

const originalKey = process.env.AI_ENCRYPTION_KEY

beforeEach(() => {
  process.env.AI_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex')
})

afterEach(() => {
  if (originalKey === undefined) delete process.env.AI_ENCRYPTION_KEY
  else process.env.AI_ENCRYPTION_KEY = originalKey
})

afterAll(async () => {
  for (const oid of createdOrgIds) await cleanupOrg(oid)
  for (const uid of createdUserIds) await cleanupUser(uid)
  await prisma.$disconnect()
})

describe('org.setAISettings / getAISettings / isAIConfigured / clearAISettings', () => {
  it('setAISettings persists an encrypted blob, never the plaintext key', async () => {
    const { orgId, adminUserId } = await makeOrgWithMember('ai-set')
    const caller = callerFor(adminUserId, orgId)
    const apiKey = 'sk-ant-super-secret-plaintext-key'

    const result = await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.org.setAISettings({ provider: 'anthropic', model: 'claude-opus-4-8', apiKey }),
    )
    expect(result).toEqual({ ok: true })

    const org = await prisma.org.findUniqueOrThrow({ where: { id: orgId } })
    const settings = org.ai_settings as { api_key_encrypted?: string; provider?: string }
    expect(settings.provider).toBe('anthropic')
    expect(settings.api_key_encrypted).toBeTruthy()
    expect(settings.api_key_encrypted).not.toBe(apiKey)
    expect(JSON.stringify(settings)).not.toContain(apiKey)
  })

  it('getAISettings returns provider/model/has_api_key and never plaintext or ciphertext', async () => {
    const { orgId, adminUserId } = await makeOrgWithMember('ai-get')
    const caller = callerFor(adminUserId, orgId)
    const apiKey = 'sk-ant-another-secret-key'

    await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.org.setAISettings({ provider: 'openai', model: 'gpt-5', apiKey }),
    )

    const settings = await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.org.getAISettings(),
    )
    expect(settings).toEqual({ provider: 'openai', model: 'gpt-5', has_api_key: true })
    expect(JSON.stringify(settings)).not.toContain(apiKey)
    expect(settings).not.toHaveProperty('api_key_encrypted')
  })

  it('isAIConfigured reflects whether a key is set and is readable by a non-admin member', async () => {
    const { orgId, adminUserId, memberUserId } = await makeOrgWithMember('ai-configured')
    const adminCaller = callerFor(adminUserId, orgId)
    const memberCaller = callerFor(memberUserId, orgId)

    const before = await callAs({ userId: memberUserId, orgId, orgRole: 'member' }, () =>
      memberCaller.org.isAIConfigured(),
    )
    expect(before).toBe(false)

    await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      adminCaller.org.setAISettings({
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        apiKey: 'sk-ant-yet-another',
      }),
    )

    const after = await callAs({ userId: memberUserId, orgId, orgRole: 'member' }, () =>
      memberCaller.org.isAIConfigured(),
    )
    expect(after).toBe(true)
  })

  it('clearAISettings nulls the stored key but keeps provider/model', async () => {
    const { orgId, adminUserId } = await makeOrgWithMember('ai-clear')
    const caller = callerFor(adminUserId, orgId)

    await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.org.setAISettings({
        provider: 'google',
        model: 'gemini-2.5-pro',
        apiKey: 'sk-google-secret',
      }),
    )

    const clearResult = await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.org.clearAISettings(),
    )
    expect(clearResult).toEqual({ ok: true })

    const org = await prisma.org.findUniqueOrThrow({ where: { id: orgId } })
    const settings = org.ai_settings as {
      api_key_encrypted?: string
      provider?: string
      model?: string
    }
    expect(settings.api_key_encrypted).toBeUndefined()
    expect(settings.provider).toBe('google')
    expect(settings.model).toBe('gemini-2.5-pro')

    const configured = await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.org.isAIConfigured(),
    )
    expect(configured).toBe(false)
  })

  it('rejects a non-admin write with FORBIDDEN', async () => {
    const { orgId, memberUserId } = await makeOrgWithMember('ai-forbidden')
    const caller = callerFor(memberUserId, orgId)

    await expect(
      callAs({ userId: memberUserId, orgId, orgRole: 'member' }, () =>
        caller.org.setAISettings({
          provider: 'anthropic',
          model: 'claude-opus-4-8',
          apiKey: 'sk-ant-should-not-work',
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(
      callAs({ userId: memberUserId, orgId, orgRole: 'member' }, () => caller.org.getAISettings()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(
      callAs({ userId: memberUserId, orgId, orgRole: 'member' }, () =>
        caller.org.clearAISettings(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
