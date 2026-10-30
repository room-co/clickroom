import { trpc } from '@/lib/trpc'

export type TaxonomyOption = {
  value: string
  label: string
  type?: 'String' | 'Numeric' | 'Boolean' | 'DateTime'
}

export type TaxonomyOptions = {
  options: TaxonomyOption[]
  isLoading: boolean
}

/**
 * Non-hidden event names for a project, shaped as autocomplete options suitable
 * for feeding a shadcn Command/Select in analytics filter/breakdown pickers.
 */
export function useEventNames(projectId: string | undefined): TaxonomyOptions {
  const { data, isLoading } = trpc.taxonomy.events.list.useQuery(
    { projectId: projectId ?? '' },
    { enabled: !!projectId },
  )

  const options: TaxonomyOption[] = (data ?? []).map((e) => ({
    value: e.name,
    label: e.name,
  }))

  return { options, isLoading }
}

/**
 * Event-scoped property options for a project. When `eventName` is supplied the
 * result is restricted to properties observed on that event (contextual
 * autocomplete). Each option carries its `type` for downstream operator hints.
 */
export function useEventProperties(
  projectId: string | undefined,
  eventName?: string,
): TaxonomyOptions {
  const { data, isLoading } = trpc.taxonomy.properties.list.useQuery(
    { projectId: projectId ?? '', scope: 'event', eventName },
    { enabled: !!projectId },
  )

  const options: TaxonomyOption[] = (data ?? []).map((p) => ({
    value: p.name,
    label: p.name,
    type: p.propertyType,
  }))

  return { options, isLoading }
}

/**
 * Person-scoped trait property options for a project — the catalog of known
 * `$identify` `$set` keys, used by the segment builder's trait condition rows.
 */
export function useTraitProperties(projectId: string | undefined): TaxonomyOptions {
  const { data, isLoading } = trpc.taxonomy.properties.list.useQuery(
    { projectId: projectId ?? '', scope: 'person' },
    { enabled: !!projectId },
  )

  const options: TaxonomyOption[] = (data ?? []).map((p) => ({
    value: p.name,
    label: p.name,
    type: p.propertyType,
  }))

  return { options, isLoading }
}
