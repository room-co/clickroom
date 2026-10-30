// @clickroom/sdk-react-native — pure device property mapping. Takes a plain `DeviceInfo`, no
// react-native import — keeps this testable and reusable regardless of how the caller obtained it
// (native `Platform`/`Dimensions`, or injected in tests). Mirrors sdk-js's device.ts returning
// `Record<string, string>`, minus everything web-only ($current_url, $host, $browser*, ...).

import type { DeviceInfo } from './types'

export function mobileDeviceProps(
  info: DeviceInfo,
  opts?: { appVersion?: string; appBuild?: string },
): Record<string, string> {
  const props: Record<string, string> = {
    $os: info.os === 'ios' ? 'iOS' : 'Android',
    // Heuristic: the longer screen edge (orientation-independent) >= 900dp reads as a tablet.
    $device_type: Math.max(info.screenWidth, info.screenHeight) >= 900 ? 'Tablet' : 'Mobile',
    $screen_width: String(info.screenWidth),
    $screen_height: String(info.screenHeight),
  }

  if (info.osVersion !== undefined) props.$os_version = String(info.osVersion)
  if (info.locale) props.$lang = info.locale
  if (opts?.appVersion) props.$app_version = opts.appVersion
  if (opts?.appBuild) props.$app_build = opts.appBuild

  return props
}
