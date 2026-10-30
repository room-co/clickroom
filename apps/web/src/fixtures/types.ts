export type EventType = 'click' | 'pageview' | 'custom'

export type FlagEnv = 'production' | 'staging' | 'development'

export type UserStatus = 'active' | 'churned' | 'new'

export interface TimeSeriesPoint {
  date: string
  events: number
  sessions: number
}

export interface TopElement {
  element: string
  page: string
  clicks: number
  pct: number
}

export interface RecentEvent {
  id: number
  event: EventType
  element: string
  user: string
  page: string
  time: string
  country: string
}

export interface EventRow {
  id: string
  type: EventType
  element: string
  page: string
  user: string
  session: string
  time: string
  country: string
}

export interface SavedFunnel {
  id: string
  name: string
  steps: number
  convRate: number
  trend: number
}

export interface FunnelStep {
  name: string
  users: number
  dropOff: number
  pct: number
}

export interface FeatureFlagRow {
  id: string
  name: string
  key: string
  enabled: boolean
  rollout: number
  env: FlagEnv
  modified: string
  tags: string[]
}

export interface UserRow {
  id: string
  email: string
  firstSeen: string
  lastSeen: string
  sessions: number
  events: number
  country: string
  status: UserStatus
}
