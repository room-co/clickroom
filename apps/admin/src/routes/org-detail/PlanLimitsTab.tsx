import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatNumber } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { ConfirmActionDialog } from './ConfirmActionDialog'

interface OrgDetail {
  id: string
  planKey: string | null
  overridesRaw: {
    maxSeatsOverride: number | null
    maxEventsPerMonthOverride: number | null
    maxFlagsOverride: number | null
    maxFlagCallsPerMonthOverride: number | null
  }
  effectiveLimits: {
    maxSeats: number
    maxFlags: number
    maxEventsPerMonth: number
    maxFlagCallsPerMonth: number
    overagePolicy: 'block' | 'allow'
  }
}

/**
 * Plan & limits tab: `setPlan`, `setLimitOverrides`, `setOveragePolicy` — every
 * mutation confirm-gated via `ConfirmActionDialog`. `admin.orgs` has no "list plans" procedure
 * (a genuine backend gap — see this task's final report), so plan changes use a plain text
 * input for the plan key rather than a populated `<Select>`, with the current effective limits
 * shown for context so a typo is easy to spot before confirming.
 */
export function PlanLimitsTab({ org }: { org: OrgDetail }) {
  const utils = trpc.useUtils()
  const invalidate = () => {
    void utils.admin.orgs.get.invalidate({ orgId: org.id })
    void utils.admin.orgs.list.invalidate()
  }

  const setPlan = trpc.admin.orgs.setPlan.useMutation({ onSuccess: invalidate })
  const setLimitOverrides = trpc.admin.orgs.setLimitOverrides.useMutation({ onSuccess: invalidate })
  const setOveragePolicy = trpc.admin.orgs.setOveragePolicy.useMutation({ onSuccess: invalidate })

  const [planKeyInput, setPlanKeyInput] = useState(org.planKey ?? '')
  const [overrides, setOverrides] = useState({
    maxSeatsOverride: org.overridesRaw.maxSeatsOverride,
    maxEventsPerMonthOverride: org.overridesRaw.maxEventsPerMonthOverride,
    maxFlagsOverride: org.overridesRaw.maxFlagsOverride,
    maxFlagCallsPerMonthOverride: org.overridesRaw.maxFlagCallsPerMonthOverride,
  })
  const [overagePolicy, setOveragePolicyInput] = useState(org.effectiveLimits.overagePolicy)

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Effective limits</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <LimitStat label="Seats" value={formatNumber(org.effectiveLimits.maxSeats)} />
          <LimitStat label="Flags" value={formatNumber(org.effectiveLimits.maxFlags)} />
          <LimitStat
            label="Events / month"
            value={formatNumber(org.effectiveLimits.maxEventsPerMonth)}
          />
          <LimitStat
            label="Flag calls / month"
            value={formatNumber(org.effectiveLimits.maxFlagCallsPerMonth)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Plan</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="plan-key">Plan key</Label>
            <Input
              id="plan-key"
              value={planKeyInput}
              onChange={(event) => setPlanKeyInput(event.target.value)}
              placeholder="e.g. growth"
            />
          </div>
          <ConfirmActionDialog
            trigger={
              <Button type="button" disabled={!planKeyInput.trim() || planKeyInput === org.planKey}>
                Save plan
              </Button>
            }
            title="Change org plan"
            description={`Change this org's plan from "${org.planKey ?? 'none'}" to "${planKeyInput}"? Per-org limit overrides are untouched.`}
            confirmLabel="Change plan"
            onConfirm={() => setPlan.mutateAsync({ orgId: org.id, planKey: planKeyInput.trim() })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Limit overrides</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <OverrideField
              label="Max seats"
              value={overrides.maxSeatsOverride}
              onChange={(v) => setOverrides((prev) => ({ ...prev, maxSeatsOverride: v }))}
            />
            <OverrideField
              label="Max flags"
              value={overrides.maxFlagsOverride}
              onChange={(v) => setOverrides((prev) => ({ ...prev, maxFlagsOverride: v }))}
            />
            <OverrideField
              label="Max events / month"
              value={overrides.maxEventsPerMonthOverride}
              onChange={(v) => setOverrides((prev) => ({ ...prev, maxEventsPerMonthOverride: v }))}
            />
            <OverrideField
              label="Max flag calls / month"
              value={overrides.maxFlagCallsPerMonthOverride}
              onChange={(v) =>
                setOverrides((prev) => ({ ...prev, maxFlagCallsPerMonthOverride: v }))
              }
            />
          </div>
          <div>
            <ConfirmActionDialog
              trigger={<Button type="button">Save overrides</Button>}
              title="Change limit overrides"
              description="This replaces this org's limit overrides. Leave a field blank to fall back to its plan default."
              confirmLabel="Save overrides"
              onConfirm={() => setLimitOverrides.mutateAsync({ orgId: org.id, ...overrides })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Overage policy</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1.5 sm:max-w-56">
            <Label htmlFor="overage-policy">Policy</Label>
            <Select
              value={overagePolicy}
              onValueChange={(value) => setOveragePolicyInput(value as 'block' | 'allow')}
            >
              <SelectTrigger id="overage-policy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="block">Block over quota</SelectItem>
                <SelectItem value="allow">Allow over quota</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <ConfirmActionDialog
            trigger={
              <Button type="button" disabled={overagePolicy === org.effectiveLimits.overagePolicy}>
                Save policy
              </Button>
            }
            title="Change overage policy"
            description={`Change this org's overage policy to "${overagePolicy}"?`}
            confirmLabel="Change policy"
            onConfirm={() => setOveragePolicy.mutateAsync({ orgId: org.id, overagePolicy })}
          />
        </CardContent>
      </Card>
    </div>
  )
}

function LimitStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-sm text-foreground">{value}</span>
    </div>
  )
}

function OverrideField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number | null
  onChange: (value: number | null) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Input
        type="number"
        min={0}
        value={value ?? ''}
        placeholder="Plan default"
        onChange={(event) => {
          const raw = event.target.value
          onChange(raw === '' ? null : Math.max(0, Number(raw)))
        }}
      />
    </div>
  )
}
