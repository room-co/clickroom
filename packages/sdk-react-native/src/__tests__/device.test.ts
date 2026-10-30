import { describe, expect, it } from 'vitest'
import { mobileDeviceProps } from '../device'
import type { DeviceInfo } from '../types'

describe('mobileDeviceProps', () => {
  it('maps an iOS phone', () => {
    const info: DeviceInfo = {
      os: 'ios',
      osVersion: '17.4',
      screenWidth: 390,
      screenHeight: 844,
      locale: 'en-US',
    }
    expect(mobileDeviceProps(info)).toEqual({
      $os: 'iOS',
      $os_version: '17.4',
      $device_type: 'Mobile',
      $screen_width: '390',
      $screen_height: '844',
      $lang: 'en-US',
    })
  })

  it('maps an Android phone', () => {
    const info: DeviceInfo = {
      os: 'android',
      osVersion: '14',
      screenWidth: 412,
      screenHeight: 869,
    }
    expect(mobileDeviceProps(info)).toEqual({
      $os: 'Android',
      $os_version: '14',
      $device_type: 'Mobile',
      $screen_width: '412',
      $screen_height: '869',
    })
  })

  it('treats a >=900 longer-edge screen as a Tablet', () => {
    const info: DeviceInfo = { os: 'ios', screenWidth: 834, screenHeight: 1194 }
    expect(mobileDeviceProps(info).$device_type).toBe('Tablet')
  })

  it('treats a <900 longer-edge screen as Mobile at the boundary', () => {
    const info: DeviceInfo = { os: 'android', screenWidth: 480, screenHeight: 899 }
    expect(mobileDeviceProps(info).$device_type).toBe('Mobile')
  })

  it('includes app version/build when supplied', () => {
    const info: DeviceInfo = { os: 'ios', screenWidth: 390, screenHeight: 844 }
    const props = mobileDeviceProps(info, { appVersion: '1.2.3', appBuild: '42' })
    expect(props.$app_version).toBe('1.2.3')
    expect(props.$app_build).toBe('42')
  })

  it('omits app version/build when not supplied', () => {
    const info: DeviceInfo = { os: 'ios', screenWidth: 390, screenHeight: 844 }
    const props = mobileDeviceProps(info)
    expect(props.$app_version).toBeUndefined()
    expect(props.$app_build).toBeUndefined()
  })
})
