// @clickroom/sdk-react-native/react — headless React bindings over a `ClickroomClient` instance.
// `react` is a PEER dependency, never bundled. No JSX build step needed (mirrors
// packages/sdk-js/src/react.ts's approach): `createElement` calls instead of JSX syntax.

import type * as React from 'react'
import { createContext, createElement, useContext, useEffect, useState } from 'react'
import type { ClickroomClient } from './index'

export const ClickroomContext = createContext<ClickroomClient | null>(null)

export interface ClickroomProviderProps {
  client: ClickroomClient
  children?: React.ReactNode
}

export function ClickroomProvider({
  client,
  children,
}: ClickroomProviderProps): React.ReactElement {
  return createElement(ClickroomContext.Provider, { value: client }, children)
}

/** The `ClickroomClient` from the nearest `<ClickroomProvider>`. Throws outside one — a
 *  programmer error (missing provider), not a runtime tolerance case like the SDK's own
 *  capture-before-init no-op. */
export function useClickroom(): ClickroomClient {
  const client = useContext(ClickroomContext)
  if (!client) {
    throw new Error('useClickroom() must be used within a <ClickroomProvider>')
  }
  return client
}

export function useFeatureFlag(key: string): boolean | string {
  const client = useClickroom()
  const [value, setValue] = useState<boolean | string>(() => client.getFeatureFlag(key))

  useEffect(() => {
    setValue(client.getFeatureFlag(key))
    client.onFeatureFlags((flags) => {
      if (key in flags) setValue(flags[key])
    })
  }, [client, key])

  return value
}

export function useFeatureFlagPayload(key: string): unknown {
  const client = useClickroom()
  const [value, setValue] = useState<unknown>(() => client.getFeatureFlagPayload(key))

  useEffect(() => {
    setValue(client.getFeatureFlagPayload(key))
    client.onFeatureFlags(() => setValue(client.getFeatureFlagPayload(key)))
  }, [client, key])

  return value
}
