import type { PlanFeatures, PlanKey } from '@clickroom/db'
import { Lock } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

/**
 * The upsell shown when an org's plan does not include a
 * feature it navigated to.
 *
 * There is no checkout: self-serve upgrades don't exist in this product yet
 * (see `SettingsPage.tsx`'s billing tab, whose copy this reuses verbatim), so
 * the CTA is contact-sales, not a Stripe button.
 */

const FEATURE_LABELS: Record<keyof PlanFeatures, string> = {
  sqlExplorer: 'SQL Explorer',
  sso: 'Single Sign-On',
  askAi: 'Ask AI',
  mcp: 'MCP Server',
  experiments: 'Experiments',
  insights: 'Product analytics',
  segments: 'Segments',
  surveys: 'Surveys',
  support: 'Support',
  funnels: 'Funnels',
  webAnalytics: 'Web Analytics',
  dataExport: 'Data export',
  overage: 'Usage overage',
}

const PLAN_LABELS: Record<PlanKey, string> = {
  free: 'Free',
  pro: 'Pro',
  enterprise: 'Enterprise',
  unlimited: 'Unlimited',
}

export function UpgradeCard({
  feature,
  upgradeTo,
  reason,
}: {
  feature: keyof PlanFeatures
  upgradeTo: PlanKey | null
  /** The server's deny reason, when one is available (`TRPCError.cause.reason`). */
  reason?: string
}) {
  const name = FEATURE_LABELS[feature]
  const target = upgradeTo ? PLAN_LABELS[upgradeTo] : null

  return (
    <div className="p-5">
      <Card className="max-w-lg">
        <CardHeader>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
              <Lock className="w-4 h-4 text-primary" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-sm">{name} isn&apos;t on your plan</CardTitle>
              <CardDescription className="text-[11px]">
                {reason ??
                  (target
                    ? `${name} is available on the ${target} plan and above.`
                    : `${name} isn't included in your current plan.`)}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-[11px] text-muted-foreground">
            Contact your Clickroom rep to change plans. Self-serve upgrades aren&apos;t available
            yet.
          </p>
        </CardContent>
        <CardFooter className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
          <Button asChild size="sm">
            <a href="mailto:sales@clickroom.dev?subject=Upgrade%20request">Contact sales</a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to="/settings?tab=billing">View plan &amp; usage</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
