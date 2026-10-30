import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { ENV_TAB_GLOW_CLASS, envGlowVars } from '@/pages/flags/FlagBits'
import type { Environment } from '@/pages/flags/types'

/**
 * Neon-glow environment tab bar — shared by any page that lets the user
 * switch which `Environment` they're viewing (flags list, experiments list,
 * ...). Purely presentational: callers own their own `useEnvironments`
 * fetch and `env` state, this just renders the bar and reports selections.
 */
export function EnvironmentTabs({
  environments,
  value,
  onValueChange,
  className,
}: {
  environments: Environment[]
  value: string
  onValueChange: (env: string) => void
  className?: string
}) {
  return (
    <div className={className ?? 'border-b border-border px-5 py-2'}>
      <div className="overflow-x-auto">
        <Tabs value={value} onValueChange={onValueChange}>
          <TabsList className="w-max">
            {environments.map((e) => (
              <TabsTrigger
                key={e.key}
                value={e.key}
                className={cn('min-w-[84px] shrink-0', ENV_TAB_GLOW_CLASS)}
                style={envGlowVars(e.color, e.key)}
              >
                {e.name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
    </div>
  )
}
