// Server-to-server client for `services/query` (Rust/Axum, SQL
// Explorer). The projectId passed here MUST be the server-authorized value
// (post `scopedForProject`), never anything read from user-supplied SQL text
// — `services/query` trusts it verbatim when rewriting the query to inject
// `WHERE project_id = '<pid>'`.

const QUERY_SERVICE_URL = process.env.QUERY_SERVICE_URL ?? 'http://localhost:3002'
const INTERNAL_QUERY_SECRET = process.env.INTERNAL_QUERY_SECRET

export interface QueryServiceRequest {
  projectId: string
  sql: string
  limit?: number
}

export interface QueryServiceResult {
  columns: Array<{ name: string; type: string }>
  rows: unknown[][]
  rowCount: number
  elapsedMs: number
  rowsRead: number
  bytesRead: number
}

export class QueryServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'QueryServiceError'
  }
}

/**
 * POST /query to `services/query`. Throws {@link QueryServiceError} on any
 * non-2xx response — callers map `status < 500` to `TRPCError BAD_REQUEST`
 * and `status >= 500` to `TRPCError INTERNAL_SERVER_ERROR`.
 */
// A little above services/query's own reqwest timeout (QUERY_TIMEOUT_SECS +
// 5s = 35s by default), so a stuck upstream connection can't hang this fetch
// forever if services/query's own timeout doesn't fire first.
const FETCH_TIMEOUT_MS = 37_000

export async function runQuery(req: QueryServiceRequest): Promise<QueryServiceResult> {
  if (!INTERNAL_QUERY_SECRET) {
    throw new Error('runQuery: INTERNAL_QUERY_SECRET is not set.')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetch(`${QUERY_SERVICE_URL}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INTERNAL_QUERY_SECRET}`,
      },
      body: JSON.stringify({
        projectId: req.projectId,
        sql: req.sql,
        limit: req.limit ?? null,
      }),
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new QueryServiceError('Query service request timed out.', 504)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string }
    throw new QueryServiceError(body.error ?? 'Query service request failed.', res.status)
  }

  return (await res.json()) as QueryServiceResult
}
