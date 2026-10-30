// SQL domain — mirrors `apps/api/src/trpc/routers/sql-explorer.router.ts`
// (`sqlExplorerRouter`, mounted as `sqlExplorer`).
//
// NOTE: `sqlExplorer.run` is a tRPC `.mutation()` in the router (it proxies
// to the remote query service rather than touching Postgres/ClickHouse
// directly), but it is read-only in effect — no state changes, matching the
// Table's `sql_query` / mutates:no row. `mutates: false` here
// reflects that read-only *effect*; the handle() below still calls `.mutate()`
// since that's the tRPC procedure's real verb.
import { z } from 'zod'
import { jsonResult } from '../result.js'
import type { AgentTool } from '../types.js'
import { defineTool } from '../types.js'

export const sqlTools: AgentTool[] = [
  defineTool({
    name: 'data_sources_list',
    description:
      'List connected data sources for a project (needed to get a sourceId for sql_query).',
    category: 'sql',
    mutates: false,
    input: z.object({ projectId: z.string() }),
    handle: async (input, ctx) => jsonResult(await ctx.client.dataSources.list.query(input)),
  }),
  defineTool({
    name: 'sql_query',
    description: 'Run a read-only SQL query against a connected data source via the SQL Explorer.',
    category: 'sql',
    mutates: false,
    input: z.object({
      projectId: z.string(),
      sourceId: z.string(),
      sql: z.string(),
      limit: z.number().optional(),
    }),
    handle: async (input, ctx) => jsonResult(await ctx.client.sqlExplorer.run.mutate(input)),
  }),
]
