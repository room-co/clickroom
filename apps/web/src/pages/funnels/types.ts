export type FunnelOperator = 'exact' | 'is_not' | 'icontains' | 'gt' | 'lt' | 'is_set'

export interface FunnelStepFilter {
  key: string
  operator: FunnelOperator
  value: unknown
}

export interface FunnelStep {
  event: string
  alias?: string
  filters: FunnelStepFilter[]
}

export interface SavedFunnel {
  id: string
  name: string
  window: number
  steps: FunnelStep[]
}
