import { ArrowLeft } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router'
import { SkeletonCard, SkeletonText } from '@/components/skeletons'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { trpc } from '@/lib/trpc'
import { AuditTab } from './org-detail/AuditTab'
import { MembersTab } from './org-detail/MembersTab'
import { OverviewTab } from './org-detail/OverviewTab'
import { PlanLimitsTab } from './org-detail/PlanLimitsTab'
import { UsageTab } from './org-detail/UsageTab'

const TABS = ['overview', 'members', 'plan', 'usage', 'audit'] as const
type OrgDetailTab = (typeof TABS)[number]

function toTab(value: string | null): OrgDetailTab {
  return (TABS as readonly string[]).includes(value ?? '') ? (value as OrgDetailTab) : 'overview'
}

/**
 * `/orgs/:id`. Tabs: Overview · Members · Plan & limits · Usage · Audit. The active tab
 * lives in the `?tab=` search param (not component state) so a direct link to e.g.
 * `/orgs/:id?tab=plan` lands on the right tab — useful for support workflows that jump straight
 * to plan/limits.
 */
export function OrgDetailPage() {
  const { id } = useParams<{ id: string }>()
  const orgId = id ?? ''
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = toTab(searchParams.get('tab'))

  const query = trpc.admin.orgs.get.useQuery({ orgId }, { enabled: Boolean(orgId) })

  function setTab(next: string) {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        params.set('tab', next)
        return params
      },
      { replace: true },
    )
  }

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <Link
        to="/orgs"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Orgs
      </Link>

      {query.isPending ? (
        <div className="flex flex-col gap-4">
          <SkeletonText lines={2} className="max-w-sm" />
          <SkeletonCard lines={4} />
        </div>
      ) : query.isError ? (
        <p className="text-sm text-destructive">Failed to load org: {query.error.message}</p>
      ) : (
        <>
          <div>
            <h1 className="text-xl font-semibold text-foreground">{query.data.name}</h1>
            <p className="text-sm text-muted-foreground">{query.data.slug}</p>
          </div>

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="flex-wrap">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="members">Members</TabsTrigger>
              <TabsTrigger value="plan">Plan &amp; limits</TabsTrigger>
              <TabsTrigger value="usage">Usage</TabsTrigger>
              <TabsTrigger value="audit">Audit</TabsTrigger>
            </TabsList>
            <TabsContent value="overview">
              <OverviewTab org={query.data} />
            </TabsContent>
            <TabsContent value="members">
              <MembersTab orgId={orgId} />
            </TabsContent>
            <TabsContent value="plan">
              <PlanLimitsTab org={query.data} />
            </TabsContent>
            <TabsContent value="usage">
              <UsageTab orgId={orgId} />
            </TabsContent>
            <TabsContent value="audit">
              <AuditTab orgId={orgId} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  )
}
