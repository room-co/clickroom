// Catches drift between `packages/agent-tools`' hand-mirrored Zod
// schemas and the real tRPC `appRouter` procedures they call (agent
// noted it had to hand-copy each procedure's inline `z.object` shape rather
// than import it directly in most cases, so nothing stops the two from
// silently diverging as routers change).
//
// Approach (deliberately schema-level, not a live DB/HTTP round-trip):
//
// 1. Every `AgentTool.handle()` body is a one-line
//    `ctx.client.<dotted.path>.<query|mutate>(input)` call. Extracting
//    `<dotted.path>` + verb from the function's own source via regex and
//    resolving it against the REAL `appRouter._def.procedures` (tRPC v11
//    flattens nested routers into dot-joined keys, e.g. `taxonomy.events.list`)
//    is what actually catches "tool references a procedure that no longer
//    exists/was renamed" drift — the regression this test exists for. `appRouter`
//    is imported at runtime from `@clickroom/trpc-router`, the standalone package
//    the routers live in — so `apps/mcp` never depends on `apps/api` at all and
//    the "no runtime dependency on apps/api" rule is structural, not a convention.
// 2. For input-schema *compatibility*, full structural Zod diffing is fragile
//    (two independently-constructed schemas rarely compare equal even when
//    semantically identical). Instead one representative read tool
//    (`flags_list`) and one mutate tool (`flag_toggle`) get realistic sample
//    input parsed through BOTH the tool's mirrored schema and the real
//    procedure's schema, asserting they accept/reject the same inputs — this
//    is the "smokes one read + one mutate end-to-end" the spec asks for,
//    scoped to the schema layer. A full DB/HTTP round-trip across the whole
//    tool set already exists at `apps/api/src/test/mcp.test.ts` (boots a real
//    Nest server); duplicating that here would make `apps/mcp`'s tests depend
//    on `apps/api`'s Nest/Express runtime, which is exactly what the "no
//    runtime dependency on apps/api" rule for this package is about avoiding.
import { AGENT_TOOLS } from '@clickroom/agent-tools'
import { appRouter } from '@clickroom/trpc-router'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

type ProcedureType = 'query' | 'mutation' | 'subscription'

// `appRouter._def.procedures` is tRPC v11's flat map of dot-joined procedure
// path -> procedure def (`{ type, inputs, ... }`). This shape isn't exposed
// in `AppRouter`'s public (client-facing) type, so it's read off the real
// runtime router value via an `unknown` cast rather than typed structurally.
const REAL_PROCEDURES = (
  appRouter as unknown as { _def: { procedures: Record<string, RealProcedure> } }
)._def.procedures

interface RealProcedure {
  _def: { type: ProcedureType; inputs: z.ZodTypeAny[] }
}

// `sql_query`'s tool is declared `mutates: false` (it's a read from the
// caller's perspective — arbitrary SELECTs) but its backing procedure,
// `sqlExplorer.run`, is a tRPC `.mutation()` because running a query has
// side effects worth audit-logging server-side. Documented, intentional
// deviation.
const KNOWN_MUTATES_DEVIATIONS = new Set(['sql_query'])

/** Pulls `<dotted.procedure.path>` and the tRPC call verb out of a tool's own `handle()` source. */
function resolveToolProcedure(tool: (typeof AGENT_TOOLS)[number]) {
  const source = tool.handle.toString()
  const match = source.match(/ctx\.client\.([a-zA-Z0-9_.]+)\.(query|mutate)\(/)
  if (!match) {
    throw new Error(
      `${tool.name}: could not find a "ctx.client.<path>.(query|mutate)(...)" call in its handle() — tool-parity can't verify it`,
    )
  }
  const [, path, verb] = match
  return { path, verb: verb as 'query' | 'mutate' }
}

describe('AGENT_TOOLS <-> real appRouter parity', () => {
  it('every tool maps to a real appRouter procedure of the matching type', () => {
    const missing: string[] = []
    const typeMismatches: string[] = []

    for (const tool of AGENT_TOOLS) {
      const { path, verb } = resolveToolProcedure(tool)
      const procedure = REAL_PROCEDURES[path]
      if (!procedure) {
        missing.push(`${tool.name} -> appRouter.${path} (no such procedure)`)
        continue
      }
      const expectedType: ProcedureType = verb === 'query' ? 'query' : 'mutation'
      if (procedure._def.type !== expectedType) {
        typeMismatches.push(
          `${tool.name} -> appRouter.${path} is a ${procedure._def.type}, tool calls it as a ${expectedType}`,
        )
      }
    }

    expect(missing, missing.join('\n')).toEqual([])
    expect(typeMismatches, typeMismatches.join('\n')).toEqual([])
  })

  it('tool.mutates agrees with the backing procedure verb (documented deviations excepted)', () => {
    const mismatches: string[] = []

    for (const tool of AGENT_TOOLS) {
      if (KNOWN_MUTATES_DEVIATIONS.has(tool.name)) continue
      const { verb } = resolveToolProcedure(tool)
      const expectedMutates = verb === 'mutate'
      if (tool.mutates !== expectedMutates) {
        mismatches.push(`${tool.name}: mutates=${tool.mutates}, but calls .${verb}()`)
      }
    }

    expect(mismatches, mismatches.join('\n')).toEqual([])
  })

  it('every tool name resolves to exactly one procedure (no accidental duplicate mapping)', () => {
    const seen = new Map<string, string>()
    const duplicates: string[] = []
    for (const tool of AGENT_TOOLS) {
      const { path } = resolveToolProcedure(tool)
      const key = path
      const existing = seen.get(key)
      // Multiple tools may legitimately wrap the same procedure only if the
      // spec's table says so — none currently do, so any repeat is drift.
      if (existing) duplicates.push(`${tool.name} and ${existing} both map to appRouter.${key}`)
      seen.set(key, tool.name)
    }
    expect(duplicates, duplicates.join('\n')).toEqual([])
  })

  it('smokes one read tool (flags_list) end-to-end against the real schema', () => {
    const tool = AGENT_TOOLS.find((t) => t.name === 'flags_list')
    if (!tool) throw new Error('flags_list tool not found')
    const { path } = resolveToolProcedure(tool)
    const realInputSchema = REAL_PROCEDURES[path]._def.inputs[0]

    const validInput = { projectId: 'proj_123', env: 'production' }
    expect(tool.input.safeParse(validInput).success).toBe(true)
    expect(realInputSchema.safeParse(validInput).success).toBe(true)

    const invalidInput = { projectId: 'proj_123' } // missing required `env`
    expect(tool.input.safeParse(invalidInput).success).toBe(false)
    expect(realInputSchema.safeParse(invalidInput).success).toBe(false)
  })

  it('smokes one mutate tool (flag_toggle) end-to-end against the real schema', () => {
    const tool = AGENT_TOOLS.find((t) => t.name === 'flag_toggle')
    if (!tool) throw new Error('flag_toggle tool not found')
    const { path } = resolveToolProcedure(tool)
    const realInputSchema = REAL_PROCEDURES[path]._def.inputs[0]

    const validInput = { projectId: 'proj_123', id: 'flag_456', active: true }
    expect(tool.input.safeParse(validInput).success).toBe(true)
    expect(realInputSchema.safeParse(validInput).success).toBe(true)

    const invalidInput = { projectId: 'proj_123', id: 'flag_456', active: 'yes' } // wrong type
    expect(tool.input.safeParse(invalidInput).success).toBe(false)
    expect(realInputSchema.safeParse(invalidInput).success).toBe(false)
  })
})
