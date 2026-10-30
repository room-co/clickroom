// verification: boots the real `McpServer` built by `createMcpServer`
// in-process (over an `InMemoryTransport` pair, no real network/API) and
// drives it with a real MCP `Client`, asserting `tools/list` mirrors
// `AGENT_TOOLS` and that both a read and a mutate tool round-trip through
// `AgentTool.handle()` correctly. The tRPC client itself is stubbed —
// `apps/api` isn't running in this test — so this checks the MCP wiring
// (registration + result/error shape), not live data.
import { AGENT_TOOLS } from '@clickroom/agent-tools'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Records every `.query`/`.mutate` call so assertions can check the tool
// dispatched to the right tRPC procedure with the right input, without a
// live `apps/api`.
const calls: { path: string; verb: 'query' | 'mutate'; input: unknown }[] = []

function makeStubClient(): unknown {
  function makeProxy(path: string[]): unknown {
    return new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === 'query' || prop === 'mutate') {
            return async (input: unknown) => {
              calls.push({ path: path.join('.'), verb: prop, input })
              return { stub: true, path: path.join('.') }
            }
          }
          return makeProxy([...path, prop])
        },
      },
    )
  }
  return makeProxy([])
}

vi.mock('../trpc-client.js', () => ({
  createTrpcClient: () => makeStubClient(),
}))

// Imported after the mock so `server.ts` picks up the stub client factory.
const { createMcpServer } = await import('../server.js')

async function connectedClient(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return client
}

describe('createMcpServer', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('registers every AGENT_TOOLS entry, listed via tools/list', async () => {
    const server = createMcpServer('ckmcp_test-token', 'http://127.0.0.1:0/trpc', 30_000)
    const client = await connectedClient(server)

    const { tools } = await client.listTools()

    expect(tools.length).toBe(AGENT_TOOLS.length)
    const listedNames = new Set(tools.map((tool) => tool.name))
    for (const tool of AGENT_TOOLS) {
      expect(listedNames.has(tool.name)).toBe(true)
    }
  })

  it('round-trips a read tool call through AgentTool.handle()', async () => {
    const server = createMcpServer('ckmcp_test-token', 'http://127.0.0.1:0/trpc', 30_000)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'flags_list',
      arguments: { projectId: 'proj_1', env: 'production' },
    })

    expect(result.isError).toBeFalsy()
    expect(calls).toEqual([
      { path: 'flags.list', verb: 'query', input: { projectId: 'proj_1', env: 'production' } },
    ])
    const content = result.content as { type: string; text: string }[]
    expect(JSON.parse(content[0].text)).toEqual({ stub: true, path: 'flags.list' })
  })

  it('round-trips a mutate tool call through AgentTool.handle()', async () => {
    const server = createMcpServer('ckmcp_test-token', 'http://127.0.0.1:0/trpc', 30_000)
    const client = await connectedClient(server)

    const result = await client.callTool({
      name: 'flag_toggle',
      arguments: { projectId: 'proj_1', id: 'flag_1', active: true },
    })

    expect(result.isError).toBeFalsy()
    expect(calls).toEqual([
      {
        path: 'flags.toggle',
        verb: 'mutate',
        input: { projectId: 'proj_1', id: 'flag_1', active: true },
      },
    ])
  })

  it('maps a FORBIDDEN tRPC error to an isError result carrying the -32002 JSON-RPC code', async () => {
    const { TRPCClientError } = await import('@trpc/client')
    const { toToolErrorResult } = await import('../errors.js')

    const err = new TRPCClientError('not allowed', {
      result: { error: { code: -32600, message: 'not allowed', data: { code: 'FORBIDDEN' } } },
    } as never)
    const mapped = toToolErrorResult(err)

    expect(mapped.isError).toBe(true)
    expect(mapped.content[0]?.text).toContain('-32002')
    expect(mapped.content[0]?.text).toContain('FORBIDDEN')
  })
})
