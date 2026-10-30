import { prisma } from '@clickroom/db'
import {
  isAllowedRedirectUri,
  McpOAuthClientStore,
  oauthClientRowToSdk,
} from '@clickroom/trpc-router/mcp/oauth/client-store.js'
import { afterAll, describe, expect, it } from 'vitest'

const suffix = Date.now().toString(36)
const store = new McpOAuthClientStore(prisma)
const createdClientIds: string[] = []

afterAll(async () => {
  await prisma.mcpOAuthClient.deleteMany({ where: { clientId: { in: createdClientIds } } })
  await prisma.$disconnect()
})

describe('isAllowedRedirectUri', () => {
  it('allows any https:// URI', () => {
    expect(isAllowedRedirectUri('https://example.com/callback')).toBe(true)
  })

  it('allows loopback http (127.0.0.1, localhost)', () => {
    expect(isAllowedRedirectUri('http://127.0.0.1:9999/callback')).toBe(true)
    expect(isAllowedRedirectUri('http://localhost:9999/callback')).toBe(true)
  })

  it('rejects non-loopback http', () => {
    expect(isAllowedRedirectUri('http://example.com/callback')).toBe(false)
  })

  it('rejects malformed input without throwing', () => {
    expect(isAllowedRedirectUri('not a url')).toBe(false)
  })
})

describe('oauthClientRowToSdk', () => {
  it('omits client_secret entirely — never a bare null (the DCR bug this rewrite fixes)', () => {
    const info = oauthClientRowToSdk({
      clientId: 'mcp_client_x',
      clientName: 'Test',
      redirectUris: ['https://example.com/cb'],
      grantTypes: [],
      responseTypes: [],
      scope: null,
      tokenEndpointAuthMethod: 'none',
      createdAt: new Date(),
    })
    expect('client_secret' in info).toBe(false)
    expect(info.token_endpoint_auth_method).toBe('none')
  })

  it('defaults grant_types/response_types when the row has none stored', () => {
    const info = oauthClientRowToSdk({
      clientId: 'mcp_client_y',
      clientName: null,
      redirectUris: [],
      grantTypes: [],
      responseTypes: [],
      scope: null,
      tokenEndpointAuthMethod: 'none',
      createdAt: new Date(),
    })
    expect(info.grant_types).toEqual(['authorization_code', 'refresh_token'])
    expect(info.response_types).toEqual(['code'])
  })
})

describe('McpOAuthClientStore', () => {
  it('registers a public PKCE client and returns a client_id with no secret field', async () => {
    const client = await store.registerClient({
      redirect_uris: ['http://127.0.0.1:9999/callback'],
      client_name: `register-${suffix}`,
    })
    createdClientIds.push(client.client_id)

    expect(client.client_id).toMatch(/^mcp_client_/)
    expect(client.token_endpoint_auth_method).toBe('none')
    expect('client_secret' in client).toBe(false)

    const row = await prisma.mcpOAuthClient.findUnique({ where: { clientId: client.client_id } })
    expect(row?.clientSecretHash).toBeNull()
    expect(row?.tokenEndpointAuthMethod).toBe('none')
  })

  it('rejects registration with no redirect_uris', async () => {
    await expect(store.registerClient({ redirect_uris: [] })).rejects.toThrow()
  })

  it('rejects a non-loopback http redirect_uri', async () => {
    await expect(
      store.registerClient({ redirect_uris: ['http://evil.example.com/callback'] }),
    ).rejects.toThrow()
  })

  it('getClient round-trips a registered client', async () => {
    const registered = await store.registerClient({
      redirect_uris: ['https://example.com/callback'],
      client_name: `roundtrip-${suffix}`,
    })
    createdClientIds.push(registered.client_id)

    const fetched = await store.getClient(registered.client_id)
    expect(fetched?.client_id).toBe(registered.client_id)
    expect(fetched?.redirect_uris).toContain('https://example.com/callback')
  })

  it('getClient returns undefined for an unknown client_id', async () => {
    await expect(store.getClient('mcp_client_does_not_exist')).resolves.toBeUndefined()
  })
})
