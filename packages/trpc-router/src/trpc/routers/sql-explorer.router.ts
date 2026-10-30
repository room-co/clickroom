import { buildSchemaColumns, clickhouse, clickhouseConfig } from '@clickroom/clickhouse'
import { newId } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { QueryServiceError, runQuery } from '../../lib/query-service.js'
import { entitlementMiddleware } from '../middleware/entitlement.js'
import { requirePermission, router, scopedForProject } from '../trpc.js'

/**
 * Every SQL Explorer procedure: `projects:read` (RBAC) then the plan gate.
 * Order matters — a user without `projects:read` gets a permissions
 * error, not an upsell. See ../middleware/entitlement.ts.
 *
 * This also gates the MCP/agent `sql_query` tool and Ask AI's SqlResultWidget,
 * which both route through these procedures. That is intended.
 */
const sqlProcedure = requirePermission('projects:read').use(
  entitlementMiddleware('feature:sql_explorer'),
)

/**
 * Tables the SQL Explorer run path actually allows — mirrors
 * `services/query/src/validate.rs`'s `ALLOWED_TABLES`. Keep in sync: if that
 * allowlist changes, update this one too, or the schema tree will show tables
 * users can't query (or hide ones they can).
 */
const QUERYABLE_TABLES = ['events', 'flag_events', 'survey_events', 'person_distinct_ids'] as const

type SchemaColumn = { name: string; type: string }
type SchemaTable = { table: string; columns: SchemaColumn[] }

const SCHEMA_CACHE_TTL_MS = 5 * 60_000
let schemaCache: { data: SchemaTable[]; expires: number } | null = null

async function fetchSchema(): Promise<SchemaTable[]> {
  if (schemaCache && schemaCache.expires > Date.now()) {
    return schemaCache.data
  }

  const rs = await clickhouse.query({
    ...buildSchemaColumns({ database: clickhouseConfig.database, tables: QUERYABLE_TABLES }),
    format: 'JSONEachRow',
  })
  const rows = await rs.json<{ table: string; name: string; type: string }>()

  const byTable = new Map<string, SchemaColumn[]>()
  for (const row of rows) {
    const columns = byTable.get(row.table) ?? []
    columns.push({ name: row.name, type: row.type })
    byTable.set(row.table, columns)
  }
  const data = QUERYABLE_TABLES.map((table) => ({ table, columns: byTable.get(table) ?? [] }))

  schemaCache = { data, expires: Date.now() + SCHEMA_CACHE_TTL_MS }
  return data
}

export const vizConfigSchema = z
  .object({
    version: z.literal(1),
    type: z.enum(['line', 'bar', 'area', 'number', 'pie']),
    xColumn: z.string(),
    yColumns: z.array(z.string()).min(1),
  })
  .strict()

export const sqlExplorerRouter = router({
  schema: sqlProcedure.input(z.object({ projectId: z.string() })).query(async ({ input, ctx }) => {
    await scopedForProject(ctx, input.projectId)
    try {
      return await fetchSchema()
    } catch (err) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: err instanceof Error ? err.message : 'Failed to load schema.',
      })
    }
  }),

  run: sqlProcedure
    .input(
      z.object({
        projectId: z.string(),
        sourceId: z.string(),
        sql: z.string(),
        limit: z.number().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Ownership assertion only — execution happens remotely in services/query.
      const pdb = await scopedForProject(ctx, input.projectId)

      const dataSource = await pdb.dataSource.findFirst({
        where: { id: input.sourceId, deletedAt: null },
      })
      if (!dataSource) throw new TRPCError({ code: 'NOT_FOUND', message: 'Data source not found.' })

      try {
        return await runQuery({
          projectId: input.projectId,
          sql: input.sql,
          limit: input.limit,
        })
      } catch (err) {
        if (err instanceof QueryServiceError) {
          throw new TRPCError({
            code: err.status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST',
            message: err.message,
          })
        }
        throw err
      }
    }),

  list: sqlProcedure.input(z.object({ projectId: z.string() })).query(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    return pdb.savedQuery.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
    })
  }),

  get: sqlProcedure
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const savedQuery = await pdb.savedQuery.findFirst({
        where: { id: input.id, deletedAt: null },
      })
      if (!savedQuery) throw new TRPCError({ code: 'NOT_FOUND', message: 'Saved query not found.' })
      return savedQuery
    }),

  save: sqlProcedure
    .input(z.object({ projectId: z.string(), name: z.string().min(1), sql: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      return pdb.savedQuery.create({
        data: {
          id: newId(),
          projectId: input.projectId,
          name: input.name,
          sql: input.sql,
          createdBy: ctx.tokenPayload?.sub ?? '',
        },
      })
    }),

  update: sqlProcedure
    .input(
      z.object({
        projectId: z.string(),
        id: z.string(),
        patch: z
          .object({
            name: z.string().min(1).optional(),
            sql: z.string().min(1).optional(),
          })
          .strict(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.savedQuery.updateMany({
        where: { id: input.id, deletedAt: null },
        data: {
          ...(input.patch.name !== undefined && { name: input.patch.name }),
          ...(input.patch.sql !== undefined && { sql: input.patch.sql }),
        },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Saved query not found.' })
      }
      return pdb.savedQuery.findFirstOrThrow({ where: { id: input.id } })
    }),

  delete: sqlProcedure
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.savedQuery.updateMany({
        where: { id: input.id, deletedAt: null },
        data: { deletedAt: new Date() },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Saved query not found.' })
      }
      return { id: input.id, deleted: true }
    }),

  viz: router({
    list: sqlProcedure
      .input(z.object({ projectId: z.string(), savedQueryId: z.string() }))
      .query(async ({ input, ctx }) => {
        const pdb = await scopedForProject(ctx, input.projectId)
        return pdb.savedVisualization.findMany({
          where: { savedQueryId: input.savedQueryId, deletedAt: null },
          orderBy: { name: 'asc' },
        })
      }),

    save: sqlProcedure
      .input(
        z.object({
          projectId: z.string(),
          savedQueryId: z.string(),
          name: z.string().min(1),
          config: vizConfigSchema,
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const pdb = await scopedForProject(ctx, input.projectId)
        return pdb.savedVisualization.create({
          data: {
            id: newId(),
            projectId: input.projectId,
            savedQueryId: input.savedQueryId,
            name: input.name,
            config: input.config,
            createdBy: ctx.tokenPayload?.sub ?? '',
          },
        })
      }),

    update: sqlProcedure
      .input(
        z.object({
          projectId: z.string(),
          id: z.string(),
          patch: z
            .object({
              name: z.string().min(1).optional(),
              config: vizConfigSchema.optional(),
            })
            .strict(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const pdb = await scopedForProject(ctx, input.projectId)
        const { count } = await pdb.savedVisualization.updateMany({
          where: { id: input.id, deletedAt: null },
          data: {
            ...(input.patch.name !== undefined && { name: input.patch.name }),
            ...(input.patch.config !== undefined && { config: input.patch.config }),
          },
        })
        if (count === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Saved visualization not found.' })
        }
        return pdb.savedVisualization.findFirstOrThrow({ where: { id: input.id } })
      }),

    delete: sqlProcedure
      .input(z.object({ projectId: z.string(), id: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const pdb = await scopedForProject(ctx, input.projectId)
        const { count } = await pdb.savedVisualization.updateMany({
          where: { id: input.id, deletedAt: null },
          data: { deletedAt: new Date() },
        })
        if (count === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Saved visualization not found.' })
        }
        return { id: input.id, deleted: true }
      }),
  }),
})
