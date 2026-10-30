import { buildSegmentCount, buildSegmentMembers, clickhouse } from '@clickroom/clickhouse'
import { newId } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { requirePermission, router, scopedForProject } from '../trpc.js'
import { segmentDefinitionSchema } from './segments.schema.js'

const DEFAULT_SCAN_DAYS = 90

/**
 * ClickHouse's DateTime64 param parser accepts the `T` separator but rejects a
 * trailing `Z` (see `events.router.ts`'s `toChRange`). Lower bound for a
 * `scanDays`-capped preview scan, normalized to `YYYY-MM-DD HH:mm:ss.SSS` (UTC).
 */
function scanFromForDays(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().replace('T', ' ').replace('Z', '')
}

const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    definition: segmentDefinitionSchema.optional(),
  })
  .strict()

export const segmentsRouter = router({
  list: requirePermission('projects:read')
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      return pdb.segment.findMany({
        where: { deletedAt: null },
        orderBy: { name: 'asc' },
      })
    }),

  get: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const segment = await pdb.segment.findFirst({
        where: { id: input.id, deletedAt: null },
      })
      if (!segment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Segment not found.' })
      return segment
    }),

  create: requirePermission('projects:manage')
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1),
        description: z.string().optional(),
        definition: segmentDefinitionSchema,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      return pdb.segment.create({
        data: {
          id: newId(),
          projectId: input.projectId,
          name: input.name,
          description: input.description ?? null,
          definition: input.definition,
          createdBy: ctx.tokenPayload?.sub ?? '',
        },
      })
    }),

  update: requirePermission('projects:manage')
    .input(z.object({ projectId: z.string(), id: z.string(), patch: patchSchema }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.segment.updateMany({
        where: { id: input.id, deletedAt: null },
        data: {
          ...(input.patch.name !== undefined && { name: input.patch.name }),
          ...(input.patch.description !== undefined && { description: input.patch.description }),
          ...(input.patch.definition !== undefined && { definition: input.patch.definition }),
        },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Segment not found.' })
      }
      return pdb.segment.findFirstOrThrow({ where: { id: input.id } })
    }),

  delete: requirePermission('projects:manage')
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.segment.updateMany({
        where: { id: input.id, deletedAt: null },
        data: { deletedAt: new Date() },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Segment not found.' })
      }
      return { id: input.id, deleted: true }
    }),

  latestSnapshot: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), segmentId: z.string() }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      return pdb.segmentSnapshot.findFirst({
        where: { segmentId: input.segmentId },
        orderBy: { computedAt: 'desc' },
      })
    }),

  previewCount: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        definition: segmentDefinitionSchema,
        scanDays: z.number().int().positive().max(365).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const scanDays = input.scanDays ?? DEFAULT_SCAN_DAYS
      const rs = await clickhouse.query({
        ...buildSegmentCount({
          projectId: input.projectId,
          definition: input.definition,
          scanFrom: scanFromForDays(scanDays),
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ count: string }>()
      return { count: Number(rows[0]?.count ?? 0), scanDays }
    }),

  previewMembers: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        definition: segmentDefinitionSchema,
        scanDays: z.number().int().positive().max(365).optional(),
        page: z.number().int().positive().optional(),
        pageSize: z.number().int().positive().max(200).optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const scanDays = input.scanDays ?? DEFAULT_SCAN_DAYS
      const rs = await clickhouse.query({
        ...buildSegmentMembers({
          projectId: input.projectId,
          definition: input.definition,
          scanFrom: scanFromForDays(scanDays),
          page: input.page,
          pageSize: input.pageSize,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ person_id: string }>()
      return { members: rows.map((r) => r.person_id), scanDays }
    }),

  // Synchronous in v1 (matches scoping decision) — an unbounded
  // scan over full project history can be slow for high-volume projects. If
  // member sets grow large enough to blow the request timeout, move this to
  // a background job (e.g. a queued worker) that updates the snapshot status
  // asynchronously instead of blocking the mutation response.
  materialize: requirePermission('projects:manage')
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const segment = await pdb.segment.findFirst({
        where: { id: input.id, deletedAt: null },
      })
      if (!segment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Segment not found.' })

      const snapshotId = newId()
      await pdb.segmentSnapshot.create({
        data: {
          id: snapshotId,
          projectId: input.projectId,
          segmentId: segment.id,
          memberCount: 0,
          status: 'computing',
        },
      })

      try {
        const rs = await clickhouse.query({
          ...buildSegmentMembers({
            projectId: input.projectId,
            // biome-ignore lint/suspicious/noExplicitAny: definition is stored as Prisma Json
            definition: segment.definition as any,
          }),
          format: 'JSONEachRow',
        })
        const rows = await rs.json<{ person_id: string }>()

        if (rows.length > 0) {
          await clickhouse.insert({
            table: 'segment_members',
            format: 'JSONEachRow',
            values: rows.map((r) => ({
              project_id: input.projectId,
              segment_id: segment.id,
              snapshot_id: snapshotId,
              person_id: r.person_id,
            })),
          })
        }

        return pdb.segmentSnapshot.update({
          where: { id: snapshotId },
          data: { status: 'ready', memberCount: rows.length },
        })
      } catch (err) {
        await pdb.segmentSnapshot.update({
          where: { id: snapshotId },
          data: { status: 'failed' },
        })
        throw err
      }
    }),
})
