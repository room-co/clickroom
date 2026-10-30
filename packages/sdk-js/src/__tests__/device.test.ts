import { describe, expect, it } from 'vitest'
import { parseDevice } from '../device'

// Real-world user-agent strings.
const UA = {
  chromeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  opera:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36 OPR/92.0.0.0',
  samsung:
    'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  androidPhone:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  chromeOS:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

describe('parseDevice — browser detection', () => {
  it('desktop Chrome on Windows', () => {
    const p = parseDevice(UA.chromeWin, 'en-US')
    expect(p.$browser).toBe('Chrome')
    expect(p.$browser_version).toBe('120')
    expect(p.$os).toBe('Windows')
    expect(p.$device_type).toBe('Desktop')
  })

  it('desktop Chrome on macOS', () => {
    const p = parseDevice(UA.chromeMac, 'en-US')
    expect(p.$browser).toBe('Chrome')
    expect(p.$browser_version).toBe('121')
    expect(p.$os).toBe('macOS')
    expect(p.$device_type).toBe('Desktop')
  })

  it('Safari on macOS (not misdetected as Chrome)', () => {
    const p = parseDevice(UA.safariMac, 'en-US')
    expect(p.$browser).toBe('Safari')
    expect(p.$browser_version).toBe('17')
    expect(p.$os).toBe('macOS')
    expect(p.$device_type).toBe('Desktop')
  })

  it('Firefox on Windows', () => {
    const p = parseDevice(UA.firefox, 'en-US')
    expect(p.$browser).toBe('Firefox')
    expect(p.$browser_version).toBe('122')
    expect(p.$os).toBe('Windows')
    expect(p.$device_type).toBe('Desktop')
  })

  it('Edge (before Chrome)', () => {
    const p = parseDevice(UA.edge, 'en-US')
    expect(p.$browser).toBe('Edge')
    expect(p.$browser_version).toBe('120')
    expect(p.$os).toBe('Windows')
  })

  it('Opera (before Chrome)', () => {
    const p = parseDevice(UA.opera, 'en-US')
    expect(p.$browser).toBe('Opera')
    expect(p.$browser_version).toBe('92')
  })

  it('Samsung Internet (before Chrome)', () => {
    const p = parseDevice(UA.samsung, 'en-US')
    expect(p.$browser).toBe('Samsung Internet')
    expect(p.$browser_version).toBe('23')
    expect(p.$os).toBe('Android')
    expect(p.$device_type).toBe('Mobile')
  })
})

describe('parseDevice — device type & OS', () => {
  it('iPhone Safari → iOS + Mobile', () => {
    const p = parseDevice(UA.iphone, 'en-US')
    expect(p.$browser).toBe('Safari')
    expect(p.$os).toBe('iOS')
    expect(p.$device_type).toBe('Mobile')
  })

  it('iPad → iOS + Tablet', () => {
    const p = parseDevice(UA.ipad, 'en-US')
    expect(p.$os).toBe('iOS')
    expect(p.$device_type).toBe('Tablet')
  })

  it('Android phone (Mobile token) → Mobile', () => {
    const p = parseDevice(UA.androidPhone, 'en-US')
    expect(p.$browser).toBe('Chrome')
    expect(p.$os).toBe('Android')
    expect(p.$device_type).toBe('Mobile')
  })

  it('Android tablet (no Mobile token) → Tablet', () => {
    const p = parseDevice(UA.androidTablet, 'en-US')
    expect(p.$os).toBe('Android')
    expect(p.$device_type).toBe('Tablet')
  })

  it('Chrome OS', () => {
    const p = parseDevice(UA.chromeOS, 'en-US')
    expect(p.$os).toBe('Chrome OS')
    expect(p.$device_type).toBe('Desktop')
  })
})

describe('parseDevice — $lang passthrough & edge cases', () => {
  it('passes through navigator.language', () => {
    expect(parseDevice(UA.chromeWin, 'pt-BR').$lang).toBe('pt-BR')
  })

  it('omits $lang when language is undefined', () => {
    expect(parseDevice(UA.chromeWin, undefined)).not.toHaveProperty('$lang')
  })

  it('returns no undefined values (only determinable keys)', () => {
    const p = parseDevice('', undefined)
    for (const v of Object.values(p)) expect(v).not.toBeUndefined()
  })
})
