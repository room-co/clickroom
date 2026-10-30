// @clickroom/sdk-react-native — the ONLY file in this package that imports from 'react-native'.
// Everything else takes injected deps so it can be tested under plain Node with no RN mock.
// This file itself must stay safely importable even when neither 'react-native' nor
// '@react-native-async-storage/async-storage' is installed — callers reach it only lazily
// (dynamic `import()` wrapped in try/catch), never at this package's top level.

import { AppState, Dimensions, Platform } from 'react-native'
import type { DeviceInfo, StorageAdapter } from '../types'

export function nativeDevice(): DeviceInfo {
  const { width, height } = Dimensions.get('window')
  const os = Platform.OS === 'ios' ? 'ios' : 'android'
  let locale: string | undefined
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    // Hermes should always have Intl, but never let locale detection crash init().
  }
  return {
    os,
    osVersion: Platform.Version === undefined ? undefined : String(Platform.Version),
    screenWidth: width,
    screenHeight: height,
    locale,
  }
}

export function onAppStateChange(
  cb: (state: 'active' | 'background' | 'inactive') => void,
): () => void {
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active' || state === 'background' || state === 'inactive') cb(state)
  })
  return () => sub.remove()
}

/** Lazily wraps `@react-native-async-storage/async-storage` as a `StorageAdapter`.
 *  Returns `null` (never throws) when the package isn't installed. */
export function defaultStorageAdapter(): StorageAdapter | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AsyncStorage = require('@react-native-async-storage/async-storage').default
    if (!AsyncStorage) return null
    return {
      getItem: (key: string) => AsyncStorage.getItem(key),
      setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
      removeItem: (key: string) => AsyncStorage.removeItem(key),
      getAllKeys: () => AsyncStorage.getAllKeys(),
    }
  } catch {
    return null
  }
}
