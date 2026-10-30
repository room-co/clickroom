import { useMemo } from 'react'
import { trpc } from '@/lib/trpc'
import { defaultEnvKey, useEnvironments } from '../flags/types'

/**
 * A survey's linked flag is created in the project's default environment
 * (`surveys.router.ts` → `defaultEnvironment`). The survey row only carries
 * `featureFlagId`, so resolve the human-facing `key` (+ env) by listing flags in
 * that env and matching the id. Returns `null` until resolved / if not found.
 */
export function useLinkedFlag(
  projectId: string | undefined,
  featureFlagId: string | undefined,
): { key: string; env: string; active: boolean } | null {
  const environmentsQuery = useEnvironments(projectId)
  const environments = useMemo(() => environmentsQuery.data ?? [], [environmentsQuery.data])
  const env = defaultEnvKey(environments) ?? ''

  const flagsQuery = trpc.flags.list.useQuery(
    { projectId: projectId as string, env },
    { enabled: !!projectId && !!env },
  )

  return useMemo(() => {
    if (!featureFlagId || !flagsQuery.data) return null
    const rows = flagsQuery.data as unknown as {
      id: string
      key: string
      env: string
      active: boolean
    }[]
    const match = rows.find((f) => f.id === featureFlagId)
    return match ? { key: match.key, env: match.env, active: match.active } : null
  }, [featureFlagId, flagsQuery.data])
}
