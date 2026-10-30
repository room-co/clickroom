import { analyticsTools } from './tools/analytics.js'
import { experimentsTools } from './tools/experiments.js'
import { flagsTools } from './tools/flags.js'
import { insightsTools } from './tools/insights.js'
import { projectsTools } from './tools/projects.js'
import { segmentsTools } from './tools/segments.js'
import { sqlTools } from './tools/sql.js'
import { taxonomyTools } from './tools/taxonomy.js'
import { usageTools } from './tools/usage.js'
import { webAnalyticsTools } from './tools/web-analytics.js'
import type { AgentTool } from './types.js'

/** Every tool exposed to MCP clients (stdio bridge + remote HTTP endpoint). */
export const AGENT_TOOLS: AgentTool[] = [
  ...analyticsTools,
  ...taxonomyTools,
  ...projectsTools,
  ...flagsTools,
  ...experimentsTools,
  ...segmentsTools,
  ...insightsTools,
  ...webAnalyticsTools,
  ...usageTools,
  ...sqlTools,
]

/** Tools safe for a read-only (viewer) token/session. */
export function getReadTools(): AgentTool[] {
  return AGENT_TOOLS.filter((tool) => !tool.mutates)
}

/** Tools that change state — gated behind the same `requirePermission` their tRPC procedure enforces. */
export function getMutatingTools(): AgentTool[] {
  return AGENT_TOOLS.filter((tool) => tool.mutates)
}
