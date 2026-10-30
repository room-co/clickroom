import { createBrowserRouter } from 'react-router'
import { AppShell } from '@/components/AppShell'
import { RedirectIfAuthed } from '@/components/RedirectIfAuthed'
import { RequireAuth } from '@/components/RequireAuth'
import { RequireEntitlement } from '@/components/RequireEntitlement'
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary'
import { ApiKeysPage } from '@/pages/ApiKeysPage'
import { AskAIPage } from '@/pages/AskAIPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { DataManagementPage } from '@/pages/DataManagementPage'
import { EventDetailPage } from '@/pages/EventDetailPage'
import { EventsPage } from '@/pages/EventsPage'
import { ExperimentBuilderPage } from '@/pages/ExperimentBuilderPage'
import { ExperimentResultsPage } from '@/pages/ExperimentResultsPage'
import { ExperimentsPage } from '@/pages/ExperimentsPage'
import { FunnelBuilderPage } from '@/pages/FunnelBuilderPage'
import { FunnelsPage } from '@/pages/FunnelsPage'
import { FlagDetailPage } from '@/pages/flags/FlagDetailPage'
import { FlagsPage } from '@/pages/flags/FlagsPage'
import { InsightBuilderPage } from '@/pages/InsightBuilderPage'
import { InsightsPage } from '@/pages/InsightsPage'
import { InsightViewerPage } from '@/pages/InsightViewerPage'
import { InvitePage } from '@/pages/InvitePage'
import { LoginPage } from '@/pages/LoginPage'
import { McpConsentPage } from '@/pages/McpConsentPage'
import { McpPage } from '@/pages/McpPage'
import { ProjectsPage } from '@/pages/ProjectsPage'
import { SegmentBuilderPage } from '@/pages/SegmentBuilderPage'
import { SegmentsPage } from '@/pages/SegmentsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { SetupPage } from '@/pages/SetupPage'
import { SignupPage } from '@/pages/SignupPage'
import { SqlExplorerPage } from '@/pages/SqlExplorerPage'
import { SsoSettingsPage } from '@/pages/SsoSettingsPage'
import { WebhookDeliveriesPage } from '@/pages/settings/WebhookDeliveriesPage'
import { WebhooksSettingsPage } from '@/pages/settings/WebhooksSettingsPage'
import { SupportBuilderPage } from '@/pages/support/SupportBuilderPage'
import { SupportInboxPage } from '@/pages/support/SupportInboxPage'
import { SupportPage } from '@/pages/support/SupportPage'
import { SurveyBuilderPage } from '@/pages/surveys/SurveyBuilderPage'
import { SurveyResultsPage } from '@/pages/surveys/SurveyResultsPage'
import { SurveysPage } from '@/pages/surveys/SurveysPage'
import { UserDetailPage, UsersPage } from '@/pages/UsersPage'
import { WebAnalyticsPage } from '@/pages/WebAnalyticsPage'

export const router = createBrowserRouter([
  {
    element: <RequireAuth />,
    errorElement: <RouteErrorBoundary />,
    children: [
      // Outside `AppShell` (no sidebar/nav chrome) — this is the MCP OAuth
      // human-facing consent step (`ClickroomOAuthProvider.authorize()`
      // redirects here), driven by `trpc.mcpOAuth.*`. Still behind
      // `RequireAuth`: an unauthenticated visitor bounces to `/login` first.
      { path: 'oauth/mcp/consent', element: <McpConsentPage /> },
      {
        element: <AppShell />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'ask-ai', element: <AskAIPage /> },
          { path: 'web-analytics', element: <WebAnalyticsPage /> },
          { path: 'events', element: <EventsPage /> },
          { path: 'events/:uuid', element: <EventDetailPage /> },
          { path: 'funnels', element: <FunnelsPage /> },
          { path: 'funnels/new', element: <FunnelBuilderPage /> },
          { path: 'funnels/:id/edit', element: <FunnelBuilderPage /> },
          { path: 'segments', element: <SegmentsPage /> },
          { path: 'segments/new', element: <SegmentBuilderPage /> },
          { path: 'segments/:id/edit', element: <SegmentBuilderPage /> },
          { path: 'experiments', element: <ExperimentsPage /> },
          { path: 'experiments/new', element: <ExperimentBuilderPage /> },
          { path: 'experiments/:id/edit', element: <ExperimentBuilderPage /> },
          { path: 'experiments/:id/results', element: <ExperimentResultsPage /> },
          { path: 'insights', element: <InsightsPage /> },
          { path: 'insights/new', element: <InsightBuilderPage /> },
          { path: 'insights/:id', element: <InsightViewerPage /> },
          { path: 'insights/:id/edit', element: <InsightBuilderPage /> },
          { path: 'users', element: <UsersPage /> },
          { path: 'users/:distinctId', element: <UserDetailPage /> },
          { path: 'flags', element: <FlagsPage /> },
          { path: 'flags/:flagKey', element: <FlagDetailPage /> },
          // Entitlement-gated like the SQL Explorer route, but
          // without an internal kill-switch flag — an unentitled org gets the
          // `UpgradeCard`. `entitlementMiddleware('feature:surveys')` on the
          // `surveys.*` procedures is the real gate.
          {
            element: <RequireEntitlement action="feature:surveys" />,
            children: [
              { path: 'surveys', element: <SurveysPage /> },
              { path: 'surveys/new', element: <SurveysPage /> },
              { path: 'surveys/:id/edit', element: <SurveyBuilderPage /> },
              { path: 'surveys/:id/results', element: <SurveyResultsPage /> },
            ],
          },
          // Same gating posture as surveys above — the
          // `entitlementMiddleware('feature:support')` on the `support.*`
          // procedures is the real gate; this only decides what the org sees.
          {
            element: <RequireEntitlement action="feature:support" />,
            children: [
              { path: 'support', element: <SupportPage /> },
              { path: 'support/new', element: <SupportPage /> },
              { path: 'support/:id/edit', element: <SupportBuilderPage /> },
              { path: 'support/:id/inbox', element: <SupportInboxPage /> },
              // A standalone Settings surface rather than a
              // `?tab=` on `SettingsPage`: the support builder opens it in a new
              // tab (frame `6c`, needs a real URL) and delivery history hangs
              // off it as the child route below, which a tab param cannot
              // express. `/settings/sso` is the precedent. Gated here because the
              // `support.webhooks.*` procedures are `feature:support`-gated.
              { path: 'settings/webhooks', element: <WebhooksSettingsPage /> },
              // Frame `7a`: the delivery history is a routed PAGE, not the `5b`
              // overlay — filters, date range and the pagination cursor stack
              // all live in the query string so the view can be pasted to
              // whoever is debugging the endpoint.
              {
                path: 'settings/webhooks/:webhookId/deliveries',
                element: <WebhookDeliveriesPage />,
              },
            ],
          },
          { path: 'data-management', element: <DataManagementPage /> },
          // The route stays — `entitlementMiddleware` on
          // `sqlExplorer.*` is what actually protects the data. This guard only
          // decides what the org *sees*: flag off → bounced to `/` (the feature
          // doesn't exist for them yet), flag on but unentitled → `UpgradeCard`.
          {
            element: (
              <RequireEntitlement action="feature:sql_explorer" flag="internal-sql-explorer" />
            ),
            children: [{ path: 'sql', element: <SqlExplorerPage /> }],
          },
          { path: 'projects', element: <ProjectsPage /> },
          { path: 'api-keys', element: <ApiKeysPage /> },
          { path: 'mcp', element: <McpPage /> },
          { path: 'setup', element: <SetupPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'settings/sso', element: <SsoSettingsPage /> },
        ],
      },
    ],
  },
  // Public auth pages. Behind `RedirectIfAuthed` so arriving here with a live
  // session lands in the app instead of re-showing the form.
  {
    element: <RedirectIfAuthed />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/signup', element: <SignupPage /> },
    ],
  },
  // Deliberately ungated: an invited user may legitimately be signed in to
  // another org while accepting.
  { path: '/invite/:token', element: <InvitePage />, errorElement: <RouteErrorBoundary /> },
])
