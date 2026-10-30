import { prisma } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService, callAs, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

let adminUserId: string
let orgId: string
let projectId: string

beforeAll(async () => {
  const s = await authService.signup({
    email: `ai-admin-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `AI Org ${suffix}`,
  })
  adminUserId = s.user.id
  orgId = s.org!.id
  createdUserIds.push(adminUserId)
  createdOrgIds.push(orgId)

  const project = await prisma.project.findFirstOrThrow({ where: { orgId } })
  projectId = project.id
})

afterAll(async () => {
  await prisma.aiMessage.deleteMany({ where: { conversation: { project_id: projectId } } })
  await prisma.aiConversation.deleteMany({ where: { project_id: projectId } })
  for (const oid of createdOrgIds) await cleanupOrg(oid)
  for (const uid of createdUserIds) await cleanupUser(uid)
  await prisma.$disconnect()
})

function callerFor(userId: string, orgForToken: string) {
  return appRouter.createCaller(
    makeCtx({ tokenPayload: { sub: userId, sessionId: 'test', orgId: orgForToken } }),
  )
}

const admin = () => ({ userId: adminUserId, orgId, orgRole: 'org_admin' as const })

describe('ai.listConversations / createConversation', () => {
  it('creates a conversation scoped to project+user and lists it ordered by updated_at desc', async () => {
    const caller = callerFor(adminUserId, orgId)
    const first = await callAs(admin(), () =>
      caller.ai.createConversation({ projectId, title: 'First thread' }),
    )
    const second = await callAs(admin(), () =>
      caller.ai.createConversation({ projectId, title: 'Second thread' }),
    )

    const rows = await callAs(admin(), () => caller.ai.listConversations({ projectId }))
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(first.id)
    expect(ids).toContain(second.id)
    // most recently created/updated first
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id))
  })

  it('excludes soft-deleted conversations from the list', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () =>
      caller.ai.createConversation({ projectId, title: 'To delete' }),
    )
    await callAs(admin(), () => caller.ai.deleteConversation({ projectId, id: created.id }))

    const rows = await callAs(admin(), () => caller.ai.listConversations({ projectId }))
    expect(rows.map((r) => r.id)).not.toContain(created.id)
  })
})

describe('ai.renameConversation / deleteConversation', () => {
  it('renames a conversation the caller owns', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () =>
      caller.ai.createConversation({ projectId, title: 'Original' }),
    )
    const renamed = await callAs(admin(), () =>
      caller.ai.renameConversation({ projectId, id: created.id, title: 'Renamed' }),
    )
    expect(renamed.title).toBe('Renamed')
  })

  it('renaming a missing conversation throws NOT_FOUND', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.ai.renameConversation({ projectId, id: 'nope', title: 'x' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('deleting a missing conversation throws NOT_FOUND', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.ai.deleteConversation({ projectId, id: 'nope' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('ai.getMessages replays a saved conversation in order', () => {
  it('reconstructs prior turns in insertion order', async () => {
    const caller = callerFor(adminUserId, orgId)
    const conversation = await callAs(admin(), () =>
      caller.ai.createConversation({ projectId, title: 'Replay thread' }),
    )

    const base = Date.now()
    await prisma.aiMessage.create({
      data: {
        id: `msg-1-${suffix}`,
        conversation_id: conversation.id,
        role: 'user',
        parts: [{ type: 'text', text: 'What is my DAU?' }],
        created_at: new Date(base),
      },
    })
    await prisma.aiMessage.create({
      data: {
        id: `msg-2-${suffix}`,
        conversation_id: conversation.id,
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Checking...' },
          {
            type: 'tool-analytics_active_users',
            toolCallId: 'call-dau-1',
            state: 'input-available',
          },
        ],
        // Keyed by toolCallId — the shape `ask-ai.controller.ts`'s
        // `recordToolResult` persists on tool-confirm.
        tool_calls: { 'call-dau-1': { result: { output: '{"activeUsers":42}' } } },
        created_at: new Date(base + 1000),
      },
    })
    await prisma.aiMessage.create({
      data: {
        id: `msg-3-${suffix}`,
        conversation_id: conversation.id,
        role: 'assistant',
        parts: [{ type: 'text', text: 'Your DAU is 42.' }],
        created_at: new Date(base + 2000),
      },
    })

    const messages = await callAs(admin(), () =>
      caller.ai.getMessages({ projectId, conversationId: conversation.id }),
    )

    expect(messages.map((m) => m.id)).toEqual([
      `msg-1-${suffix}`,
      `msg-2-${suffix}`,
      `msg-3-${suffix}`,
    ])
    expect(messages[0]?.role).toBe('user')
    expect(messages[1]?.parts.length).toBe(2) // text part + reconciled tool call
    const toolPart = messages[1]?.parts[1] as { state: string; output: string }
    expect(toolPart.state).toBe('output-available') // resolved via reconcile-parts.ts
    expect(toolPart.output).toBe('{"activeUsers":42}')
    expect(messages[2]?.parts).toEqual([{ type: 'text', text: 'Your DAU is 42.' }])
  })

  it('getMessages on a missing conversation throws NOT_FOUND', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.ai.getMessages({ projectId, conversationId: 'nope' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('ai cross-tenant / cross-user isolation', () => {
  it('a caller in org A gets NOT_FOUND for org B project', async () => {
    const b = await authService.signup({
      email: `ai-tenant-b-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `AI Tenant B ${suffix}`,
    })
    createdUserIds.push(b.user.id)
    createdOrgIds.push(b.org!.id)
    const bProject = await prisma.project.findFirstOrThrow({ where: { orgId: b.org!.id } })

    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.ai.listConversations({ projectId: bProject.id })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await expect(
      callAs(admin(), () =>
        caller.ai.createConversation({ projectId: bProject.id, title: 'nope' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await expect(
      callAs(admin(), () =>
        caller.ai.getMessages({ projectId: bProject.id, conversationId: 'anything' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it("another user in the SAME org/project cannot see the caller's conversation", async () => {
    const other = await authService.signup({
      email: `ai-other-user-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `AI Other User Org ${suffix}`,
    })
    createdUserIds.push(other.user.id)
    createdOrgIds.push(other.org!.id)

    // Add the other user as a member of the SAME org/project as adminUserId.
    await prisma.orgMembership.create({
      data: {
        id: `mem-${suffix}`,
        orgId,
        userId: other.user.id,
        role: 'member',
      },
    })

    const ownerCaller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () =>
      ownerCaller.ai.createConversation({ projectId, title: 'Owner only' }),
    )

    const otherCaller = callerFor(other.user.id, orgId)
    const otherActor = { userId: other.user.id, orgId, orgRole: 'member' as const }

    await expect(
      callAs(otherActor, () =>
        otherCaller.ai.getMessages({ projectId, conversationId: created.id }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await expect(
      callAs(otherActor, () =>
        otherCaller.ai.renameConversation({ projectId, id: created.id, title: 'hijacked' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const otherList = await callAs(otherActor, () =>
      otherCaller.ai.listConversations({ projectId }),
    )
    expect(otherList.map((r) => r.id)).not.toContain(created.id)

    await prisma.orgMembership.deleteMany({ where: { orgId, userId: other.user.id } })
  })
})
