import { prisma } from '@clickroom/db'
import { afterAll, describe, expect, it } from 'vitest'
import { McpGrantStore } from './grant-store.js'

const suffix = Date.now().toString(36)
const store = new McpGrantStore(prisma)
const userIds: string[] = [`grant-user-${suffix}`]

afterAll(async () => {
  await prisma.mcpOAuthRefreshToken.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.$disconnect()
})

describe('McpGrantStore', () => {
  it('creates a grant and issues a usable refresh token', async () => {
    const grant = await store.createGrant({
      clientId: 'mcp_client_grant_1',
      userId: userIds[0]!,
      orgId: 'org-1',
      projectId: 'project-1',
    })
    expect(grant.refreshToken).toBeTruthy()
    expect(grant.expiresIn).toBeGreaterThan(0)
  })

  it('rotates a valid refresh token to a new one and invalidates the old one', async () => {
    const grant = await store.createGrant({
      clientId: 'mcp_client_grant_2',
      userId: userIds[0]!,
      orgId: 'org-2',
      projectId: 'project-2',
    })

    const rotated = await store.rotateGrant(grant.refreshToken, 'mcp_client_grant_2')
    expect(rotated).toMatchObject({ userId: userIds[0], orgId: 'org-2', projectId: 'project-2' })
    expect(rotated?.refreshToken).not.toBe(grant.refreshToken)

    // The redeemed token must no longer work (single-use rotation).
    await expect(store.rotateGrant(grant.refreshToken, 'mcp_client_grant_2')).resolves.toBeNull()
  })

  it('rejects a refresh token issued to a different client', async () => {
    const grant = await store.createGrant({
      clientId: 'mcp_client_grant_3',
      userId: userIds[0]!,
      orgId: 'org-3',
      projectId: 'project-3',
    })
    await expect(store.rotateGrant(grant.refreshToken, 'mcp_client_other')).resolves.toBeNull()
  })

  it('rejects an unknown refresh token', async () => {
    await expect(store.rotateGrant('not-a-real-token', 'mcp_client_grant_1')).resolves.toBeNull()
  })

  it('revokeByRefreshToken makes the token unusable', async () => {
    const grant = await store.createGrant({
      clientId: 'mcp_client_grant_4',
      userId: userIds[0]!,
      orgId: 'org-4',
      projectId: 'project-4',
    })
    await store.revokeByRefreshToken(grant.refreshToken)
    await expect(store.rotateGrant(grant.refreshToken, 'mcp_client_grant_4')).resolves.toBeNull()
  })

  it('revokeByRefreshToken on an unknown token is a silent no-op', async () => {
    await expect(store.revokeByRefreshToken('never-existed')).resolves.toBeUndefined()
  })
})
