import { afterEach, describe, expect, it, vi } from 'vitest'
import { mcpOAuthJwtSecret, mcpOAuthStateSecret } from './mcp-oauth.constants.js'

describe('mcp-oauth secrets fail closed', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('production without the secrets throws', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('JWT_SECRET', '')
    vi.stubEnv('MCP_OAUTH_STATE_SECRET', '')
    expect(() => mcpOAuthJwtSecret()).toThrow(/JWT_SECRET/)
    expect(() => mcpOAuthStateSecret()).toThrow(/MCP_OAUTH_STATE_SECRET/)
  })

  it('production with the secrets uses them', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('JWT_SECRET', 'j')
    vi.stubEnv('MCP_OAUTH_STATE_SECRET', 's')
    expect(mcpOAuthJwtSecret()).toBe('j')
    expect(mcpOAuthStateSecret()).toBe('s')
  })

  it('development falls back to the dev literals', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('JWT_SECRET', '')
    vi.stubEnv('MCP_OAUTH_STATE_SECRET', '')
    expect(mcpOAuthJwtSecret()).toBe('dev-only-change-me')
    expect(mcpOAuthStateSecret()).toBe('dev-mcp-oauth-state-secret')
  })
})
