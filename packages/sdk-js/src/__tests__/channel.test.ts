import { describe, expect, it } from 'vitest'
import { classifyChannel } from '../channel'

describe('classifyChannel', () => {
  it('direct: no referrer, no UTM', () => {
    expect(classifyChannel('', {}, 'app.example.com')).toBe('direct')
  })

  it('paid: utm_medium=cpc', () => {
    expect(classifyChannel('', { $utm_medium: 'cpc' }, 'app.example.com')).toBe('paid')
  })

  it('paid: utm_medium is case-insensitive (PPC)', () => {
    expect(classifyChannel('', { $utm_medium: 'PPC' }, 'app.example.com')).toBe('paid')
  })

  it('paid: utm_medium=display', () => {
    expect(
      classifyChannel('https://www.google.com/', { $utm_medium: 'display' }, 'app.example.com'),
    ).toBe('paid')
  })

  it('organic search: google referrer', () => {
    expect(classifyChannel('https://www.google.com/search?q=x', {}, 'app.example.com')).toBe(
      'organic search',
    )
  })

  it('organic search: bing referrer', () => {
    expect(classifyChannel('https://www.bing.com/search?q=x', {}, 'app.example.com')).toBe(
      'organic search',
    )
  })

  it('organic search: duckduckgo referrer', () => {
    expect(classifyChannel('https://duckduckgo.com/', {}, 'app.example.com')).toBe('organic search')
  })

  it('social: facebook referrer', () => {
    expect(classifyChannel('https://www.facebook.com/', {}, 'app.example.com')).toBe('social')
  })

  it('social: x.com referrer', () => {
    expect(classifyChannel('https://x.com/someone', {}, 'app.example.com')).toBe('social')
  })

  it('social: linkedin referrer', () => {
    expect(classifyChannel('https://www.linkedin.com/feed', {}, 'app.example.com')).toBe('social')
  })

  it('email: utm_medium=email with no referrer', () => {
    expect(classifyChannel('', { $utm_medium: 'email' }, 'app.example.com')).toBe('email')
  })

  it('referral: other external referrer', () => {
    expect(classifyChannel('https://news.ycombinator.com/', {}, 'app.example.com')).toBe('referral')
  })

  it('direct: referrer is same host as current page', () => {
    expect(classifyChannel('https://app.example.com/other-page', {}, 'app.example.com')).toBe(
      'direct',
    )
  })

  it('paid takes priority over a search-engine referrer', () => {
    expect(
      classifyChannel('https://www.google.com/', { $utm_medium: 'cpc' }, 'app.example.com'),
    ).toBe('paid')
  })

  it('organic search takes priority over email utm_medium when referrer is a search engine', () => {
    // utm_medium=email rule only applies when it reaches step 5 — a search
    // referrer is matched first per the rule ordering.
    expect(
      classifyChannel('https://www.google.com/', { $utm_medium: 'email' }, 'app.example.com'),
    ).toBe('organic search')
  })

  it('falls back to direct for a malformed referrer URL', () => {
    expect(classifyChannel('not-a-url', {}, 'app.example.com')).toBe('direct')
  })
})
