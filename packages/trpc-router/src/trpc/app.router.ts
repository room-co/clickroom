import { adminAuditRouter } from './routers/admin-audit.router.js'
import { adminAuthRouter } from './routers/admin-auth.router.js'
import { adminHealthRouter } from './routers/admin-health.router.js'
import { adminImpersonateRouter } from './routers/admin-impersonate.router.js'
import { adminOrgsRouter } from './routers/admin-orgs.router.js'
import { adminUsageRouter } from './routers/admin-usage.router.js'
import { aiRouter } from './routers/ai.router.js'
import { authRouter } from './routers/auth.router.js'
import { dashboardRouter } from './routers/dashboard.router.js'
import { dataSourcesRouter } from './routers/data-sources.router.js'
import { entitlementsRouter } from './routers/entitlements.router.js'
import { environmentsRouter } from './routers/environments.router.js'
import { eventsRouter } from './routers/events.router.js'
import { experimentsRouter } from './routers/experiments.router.js'
import { flagsRouter } from './routers/flags.router.js'
import { funnelsRouter } from './routers/funnels.router.js'
import { insightsRouter } from './routers/insights.router.js'
import { mcpKeyRouter } from './routers/mcp-key.router.js'
import { mcpOAuthRouter } from './routers/mcp-oauth.router.js'
import { orgRouter } from './routers/org.router.js'
import { projectsRouter } from './routers/projects.router.js'
import { segmentsRouter } from './routers/segments.router.js'
import { sqlExplorerRouter } from './routers/sql-explorer.router.js'
import { ssoRouter } from './routers/sso.router.js'
import { supportRouter } from './routers/support.router.js'
import { surveysRouter } from './routers/surveys.router.js'
import { taxonomyRouter } from './routers/taxonomy.router.js'
import { usageRouter } from './routers/usage.router.js'
import { webAnalyticsRouter } from './routers/web-analytics.router.js'
import { publicProcedure, router } from './trpc.js'

// Cross-tenant admin-console surface, guarded end-to-end by
// `adminProcedure` (: one mount point, one errorFormatter, one CORS
// policy instead of a second exported AppRouter).
const adminRouter = router({
  orgs: adminOrgsRouter,
  usage: adminUsageRouter,
  impersonate: adminImpersonateRouter,
  health: adminHealthRouter,
  audit: adminAuditRouter,
})

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, serverTime: new Date().toISOString() })),
  ai: aiRouter,
  auth: authRouter,
  adminAuth: adminAuthRouter,
  admin: adminRouter,
  org: orgRouter,
  projects: projectsRouter,
  entitlements: entitlementsRouter,
  environments: environmentsRouter,
  events: eventsRouter,
  experiments: experimentsRouter,
  flags: flagsRouter,
  funnels: funnelsRouter,
  insights: insightsRouter,
  mcpKey: mcpKeyRouter,
  mcpOAuth: mcpOAuthRouter,
  segments: segmentsRouter,
  dashboard: dashboardRouter,
  dataSources: dataSourcesRouter,
  sqlExplorer: sqlExplorerRouter,
  sso: ssoRouter,
  support: supportRouter,
  surveys: surveysRouter,
  taxonomy: taxonomyRouter,
  usage: usageRouter,
  webAnalytics: webAnalyticsRouter,
})

export type AppRouter = typeof appRouter
