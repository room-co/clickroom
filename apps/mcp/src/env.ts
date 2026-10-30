// stdio bridge env. Zod-validated so a misconfigured `npx
// clickroom-mcp` invocation fails fast with a readable message instead of a
// cryptic fetch error on the first tool call.
import { z } from 'zod'

const envSchema = z.object({
  /** `ckmcp_...` agent token — required, no interactive login for a headless bridge. */
  CLICKROOM_TOKEN: z.string().min(1, 'CLICKROOM_TOKEN is required (mint one from Settings > MCP)'),
  /** Public tRPC endpoint. Defaults to the hosted prod API. */
  CLICKROOM_API_URL: z.string().url().default('https://api.clickroom.co/trpc'),
  /** Per-request abort timeout, in milliseconds. */
  CLICKROOM_API_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
})

export type Env = z.infer<typeof envSchema>

/** Parses `process.env`, throwing a readable error on the first invalid/missing var. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source)
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
    )
    throw new Error(`Invalid clickroom-mcp environment:\n${issues.join('\n')}`)
  }
  return result.data
}
