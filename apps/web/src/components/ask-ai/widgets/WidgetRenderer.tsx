// Dispatches a WidgetDescriptor (built by adapter.ts's
// adaptToolPart) to its renderer. Single entry point shell/ToolSegment.tsx
// calls after successfully adapting a tool part.
import {
  AnalyticsActiveUsersWidget,
  AnalyticsInsightWidget,
  AnalyticsOverviewWidget,
} from './AnalyticsWidget'
import type { WidgetDescriptor } from './adapter'
import { ExperimentResultsWidget } from './ExperimentResultsWidget'
import { FlagsListWidget, FlagWidget } from './FlagWidget'
import { LiveFeedWidget } from './LiveFeedWidget'
import { SegmentCountWidget, SegmentDetailWidget } from './SegmentWidget'
import { SqlResultWidget } from './SqlResultWidget'
import { UserActivityWidget, UserEventsWidget, UserSessionsWidget } from './UserCard'

export function WidgetRenderer({ descriptor }: { descriptor: WidgetDescriptor }) {
  switch (descriptor.kind) {
    case 'insight':
      return <AnalyticsInsightWidget title={descriptor.title} result={descriptor.result} />
    case 'stat-overview':
      return <AnalyticsOverviewWidget stats={descriptor.stats} />
    case 'active-users':
      return <AnalyticsActiveUsersWidget count={descriptor.count} />
    case 'flag':
      return <FlagWidget flag={descriptor.flag} />
    case 'flags-list':
      return <FlagsListWidget flags={descriptor.flags} />
    case 'experiment-results':
      return (
        <ExperimentResultsWidget primary={descriptor.primary} secondary={descriptor.secondary} />
      )
    case 'live-feed':
      return <LiveFeedWidget events={descriptor.events} />
    case 'sql-result':
      return <SqlResultWidget data={descriptor.data} />
    case 'user-events':
      return <UserEventsWidget events={descriptor.events} />
    case 'user-sessions':
      return <UserSessionsWidget sessions={descriptor.sessions} />
    case 'user-activity':
      return <UserActivityWidget activity={descriptor.activity} />
    case 'segment':
      return <SegmentDetailWidget segment={descriptor.segment} />
    case 'segment-count':
      return <SegmentCountWidget count={descriptor.count} scanDays={descriptor.scanDays} />
    default: {
      // Exhaustiveness guard — if a new WidgetDescriptor variant is added
      // without a case above, this fails typecheck rather than at runtime.
      const _exhaustive: never = descriptor
      void _exhaustive
      return null
    }
  }
}
