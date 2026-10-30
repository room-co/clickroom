export type PropertyType = 'String' | 'Numeric' | 'Boolean' | 'DateTime'

export type PropertyScope = 'event' | 'person'

export type EnforcementMode = 'none' | 'warn' | 'strict'

export type SerializedEvent = {
  id: string
  projectId: string
  name: string
  isSystem: boolean
  verified: boolean
  hidden: boolean
  description: string | null
  lastSeenAt: string | null
  volume30d: number
  enforcementMode: EnforcementMode
  createdAt: string
  updatedAt: string
}

export type SerializedProperty = {
  id: string
  projectId: string
  name: string
  scope: PropertyScope
  propertyType: PropertyType
  typeLocked: boolean
  isNumerical: boolean
  verified: boolean
  hidden: boolean
  description: string | null
  lastSeenAt: string | null
  createdAt: string
  updatedAt: string
}
