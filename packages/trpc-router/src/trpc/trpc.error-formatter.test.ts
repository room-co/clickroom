import type { EntitlementService } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { describe, expect, it } from 'vitest'
import type { Context } from './context.js'
import { entitlementMiddleware } from './middleware/entitlement.js'
import { publicProcedure, router } from './trpc.js'

// `createCaller` bypasses the errorFormatter entirely — it rethrows the raw
// `TRPCError`, so a caller-based test would pass even if the formatter were
// deleted. These tests therefore drive a REAL tRPC HTTP request through
// `fetchRequestHandler` and assert on the JSON body the client would receive,
// which is the only path that proves `error.cause` reaches the wire.
//
// The procedures below are built from the very `router`/`publicProcedure`
// exported by ./trpc.ts, so they share that file's `initTRPC` instance — and
// therefore its errorFormatter. The app router's own procedures need Postgres +
// ClickHouse, which this package's vitest config deliberately has no harness for
// (see vitest.config.ts); a local router keeps the test pure while still
// exercising the production formatter.

/** Stands in for the org's real `EntitlementService`: always denies. */
const denyingEntitlements = {
  check: async () => ({
    allowed: false,
    reason: 'Your plan does not include SQL Explorer.',
    planKey: 'free',
    upgradeTo: 'pro' as const,
  }),
} as unknown as EntitlementService

const testRouter = router({
  // The REAL entitlement middleware builds the real cause payload — the shape
  // asserted below is not hand-copied from the middleware.
  notEntitled: publicProcedure
    .use(entitlementMiddleware('feature:sql_explorer'))
    .query(() => 'unreachable'),

  // A driver/DB error wrapped by a procedure. Must NOT be forwarded: its
  // message and stack would leak internals (query text) to the caller.
  errorCause: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Query failed.',
      cause: new Error('syntax error at or near "SELECT secret FROM internal_table"'),
    })
  }),

  // The sharpest leak case: a real driver error that DOES carry a string `code`
  // of its own (Prisma `P2002`, Node `ECONNREFUSED`). "has a string code" alone
  // must never be enough to forward — it is still an Error, with enumerable
  // internals attached.
  errorCauseWithCode: publicProcedure.query(() => {
    const dbError = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: ['internal_table.secret_column'] },
    })
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Write failed.', cause: dbError })
  }),

  noCause: publicProcedure.query(() => {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Insufficient permissions.' })
  }),
})

interface WireError {
  error: {
    message: string
    code: number
    data: Record<string, unknown> & { code?: string; cause?: Record<string, unknown> }
  }
}

/** Issues a real tRPC HTTP GET and returns the parsed error envelope. */
async function callOverHttp(path: keyof typeof testRouter._def.procedures): Promise<WireError> {
  const res = await fetchRequestHandler({
    endpoint: '/trpc',
    req: new Request(`http://localhost/trpc/${path}`, { method: 'GET' }),
    router: testRouter,
    createContext: () => ({ entitlements: denyingEntitlements }) as unknown as Context,
    // Silence the default adapter logging of these deliberately-thrown errors.
    onError: () => {},
  })

  expect(res.ok).toBe(false)
  return (await res.json()) as WireError
}

describe('errorFormatter: structured cause on the wire', () => {
  it('forwards a not_entitled cause into the serialized error shape', async () => {
    const body = await callOverHttp('notEntitled')

    expect(body.error.data.code).toBe('FORBIDDEN')
    expect(body.error.data.cause).toEqual({
      code: 'not_entitled',
      feature: 'sqlExplorer',
      planKey: 'free',
      upgradeTo: 'pro',
    })
  })

  it('does NOT forward an Error cause (no stack/query-text leak)', async () => {
    const body = await callOverHttp('errorCause')

    expect(body.error.data).not.toHaveProperty('cause')
    expect(JSON.stringify(body)).not.toContain('internal_table')
  })

  it('does NOT forward a real Error cause even when it carries a string code', async () => {
    const body = await callOverHttp('errorCauseWithCode')

    expect(body.error.data).not.toHaveProperty('cause')
    expect(JSON.stringify(body)).not.toContain('secret_column')
    expect(JSON.stringify(body)).not.toContain('P2002')
  })

  it('leaves an error with no cause unchanged', async () => {
    const body = await callOverHttp('noCause')

    expect(body.error.data).not.toHaveProperty('cause')
    expect(body.error.data.code).toBe('FORBIDDEN')
    expect(body.error.message).toBe('Insufficient permissions.')
  })
})
