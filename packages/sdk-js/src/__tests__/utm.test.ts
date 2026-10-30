import { describe, expect, it } from 'vitest'
import { parseUtm } from '../utm'

describe('parseUtm', () => {
  it('parses all five utm params', () => {
    const p = parseUtm(
      '?utm_source=google&utm_medium=cpc&utm_campaign=spring&utm_term=shoes&utm_content=ad1',
    )
    expect(p).toEqual({
      $utm_source: 'google',
      $utm_medium: 'cpc',
      $utm_campaign: 'spring',
      $utm_term: 'shoes',
      $utm_content: 'ad1',
    })
  })

  it('only emits params actually present', () => {
    const p = parseUtm('?utm_source=newsletter')
    expect(p).toEqual({ $utm_source: 'newsletter' })
    expect(p).not.toHaveProperty('$utm_medium')
  })

  it('does not emit empty-string values for present-but-empty params', () => {
    const p = parseUtm('?utm_source=&utm_medium=email')
    expect(p).toEqual({ $utm_medium: 'email' })
    expect(p).not.toHaveProperty('$utm_source')
  })

  it('returns empty object for empty search string', () => {
    expect(parseUtm('')).toEqual({})
  })

  it('returns empty object when no utm params are present', () => {
    expect(parseUtm('?foo=bar&baz=qux')).toEqual({})
  })

  it('ignores unrelated query params alongside utm params', () => {
    const p = parseUtm('?foo=bar&utm_campaign=launch')
    expect(p).toEqual({ $utm_campaign: 'launch' })
  })

  it('handles a search string without the leading "?"', () => {
    const p = parseUtm('utm_source=direct-mail')
    expect(p).toEqual({ $utm_source: 'direct-mail' })
  })
})
