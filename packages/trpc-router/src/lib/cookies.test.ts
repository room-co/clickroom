/**
 * Regression tests for the legacy host-only refresh-cookie eviction (see
 * `./cookies.ts`).
 *
 * These assert on REAL `Set-Cookie` header strings, because the bug lives
 * entirely in cookie *attributes*: a cookie's identity is (name, domain, path),
 * so `domain=.clickroom.co` did not overwrite the pre-existing host-only
 * `clickroom_rt` on `api.clickroom.co` — it created a second one. Any stub
 * `res` that records "the last value written under this name" (like
 * `apps/api/src/test/helpers.ts`'s `makeRes`) is blind to exactly the thing
 * that broke, so we boot a real `express()` app over loopback HTTP and read the
 * headers the browser would actually have received. No DB/Redis is involved —
 * `authService` is injected into the tRPC context — so this stays in
 * `trpc-router`'s pure-unit suite rather than the `apps/api` integration
 * harness.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { REFRESH_TOKEN_COOKIE } from '@clickroom/auth'
import { TRPCError } from '@trpc/server'
import express from 'express'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '../trpc/context.js'
import { authRouter } from '../trpc/routers/auth.router.js'
import { clearRefreshCookie, setRefreshCookie } from './cookies.js'

const ORIGINAL_COOKIE_DOMAIN = process.env.COOKIE_DOMAIN

let server: http.Server
let baseUrl: string

/**
 * A tRPC context whose `authService.refresh` always rejects — i.e. the wedged
 * production user: the browser sent the stale host-only twin, so the selector
 * matches no live `Session`.
 */
function wedgedCtx(res: express.Response): Context {
  return {
    req: { headers: {}, cookies: { [REFRESH_TOKEN_COOKIE]: 'stale-twin-token' } },
    res,
    tokenPayload: null,
    authService: {
      refresh: async () => {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid refresh token' })
      },
    },
  } as unknown as Context
}

beforeAll(async () => {
  const app = express()

  app.post('/set', (_req, res) => {
    setRefreshCookie(res, 'live-token')
    res.status(204).end()
  })

  app.post('/clear', (_req, res) => {
    clearRefreshCookie(res)
    res.status(204).end()
  })

  // Drives the REAL `auth.refresh` procedure through a real Express response, so
  // the headers emitted on the throwing path are the ones a wedged browser gets.
  app.post('/refresh', async (_req, res) => {
    try {
      await authRouter.createCaller(wedgedCtx(res)).refresh()
      res.status(200).json({ ok: true })
    } catch (err) {
      res.status(401).json({ code: (err as TRPCError).code })
    }
  })

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})

afterEach(() => {
  // `COOKIE_DOMAIN` is read at call time; never leak it into another suite.
  if (ORIGINAL_COOKIE_DOMAIN === undefined) delete process.env.COOKIE_DOMAIN
  else process.env.COOKIE_DOMAIN = ORIGINAL_COOKIE_DOMAIN
})

/** Every raw `Set-Cookie` header for `name`, exactly as sent on the wire. */
async function setCookiesFor(path: string, name: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST' })
  return (res.headers.getSetCookie?.() ?? []).filter((raw) => raw.startsWith(`${name}=`))
}

/** The host-only eviction: expired, `Path=/`, and crucially NO `Domain=`. */
function isHostOnlyDeletion(raw: string): boolean {
  return (
    !/;\s*Domain=/i.test(raw) &&
    raw.startsWith(`${REFRESH_TOKEN_COOKIE}=;`) &&
    /Expires=Thu, 01 Jan 1970/i.test(raw)
  )
}

describe('setRefreshCookie', () => {
  it('with COOKIE_DOMAIN set, emits the host-only deletion alongside the live domain cookie', async () => {
    process.env.COOKIE_DOMAIN = '.clickroom.co'

    const cookies = await setCookiesFor('/set', REFRESH_TOKEN_COOKIE)
    expect(cookies).toHaveLength(2)

    const deletion = cookies.find(isHostOnlyDeletion)
    const live = cookies.find((raw) => /;\s*Domain=\.clickroom\.co/i.test(raw))

    // e.g. `clickroom_rt=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax`
    expect(deletion).toBeDefined()
    expect(deletion).not.toMatch(/Domain=/i)
    expect(deletion).toContain('Path=/')
    expect(deletion).toContain('HttpOnly')

    // e.g. `clickroom_rt=live-token; Max-Age=…; Domain=.clickroom.co; Path=/; …`
    expect(live).toBeDefined()
    expect(live).toContain(`${REFRESH_TOKEN_COOKIE}=live-token`)
    expect(live).toMatch(/Max-Age=\d+/)
    expect(live).toContain('Domain=.clickroom.co')
    expect(live).toContain('Path=/')
  })

  it('with COOKIE_DOMAIN unset (dev), emits ONLY the live host-only cookie — no deletion', async () => {
    delete process.env.COOKIE_DOMAIN

    const cookies = await setCookiesFor('/set', REFRESH_TOKEN_COOKIE)
    expect(cookies).toHaveLength(1)
    // Deleting the host-only cookie in dev/self-hosted (where the LIVE cookie is
    // the host-only one) would log every user out on their next request.
    expect(cookies[0]).toContain(`${REFRESH_TOKEN_COOKIE}=live-token`)
    expect(cookies[0]).not.toMatch(/Domain=/i)
    expect(cookies.some(isHostOnlyDeletion)).toBe(false)
  })
})

describe('Secure flag', () => {
  it('follows the WEB_PUBLIC_URL scheme', async () => {
    delete process.env.COOKIE_DOMAIN
    process.env.WEB_PUBLIC_URL = 'http://localhost'
    expect((await setCookiesFor('/set', REFRESH_TOKEN_COOKIE))[0]).not.toMatch(/;\s*Secure/i)

    process.env.WEB_PUBLIC_URL = 'https://app.example.com'
    expect((await setCookiesFor('/set', REFRESH_TOKEN_COOKIE))[0]).toMatch(/;\s*Secure/i)
    delete process.env.WEB_PUBLIC_URL
  })
})

describe('clearRefreshCookie', () => {
  it('with COOKIE_DOMAIN set, clears BOTH the domain-scoped cookie and the host-only twin', async () => {
    process.env.COOKIE_DOMAIN = '.clickroom.co'

    const cookies = await setCookiesFor('/clear', REFRESH_TOKEN_COOKIE)
    expect(cookies).toHaveLength(2)

    const hostOnly = cookies.find(isHostOnlyDeletion)
    const domainScoped = cookies.find((raw) => /;\s*Domain=\.clickroom\.co/i.test(raw))

    expect(hostOnly).toBeDefined()
    expect(hostOnly).not.toMatch(/Domain=/i)

    expect(domainScoped).toBeDefined()
    expect(domainScoped).toContain(`${REFRESH_TOKEN_COOKIE}=;`)
    expect(domainScoped).toMatch(/Expires=Thu, 01 Jan 1970/i)
    expect(domainScoped).toContain('Path=/')
  })

  it('with COOKIE_DOMAIN unset (dev), emits only the host-only clear', async () => {
    delete process.env.COOKIE_DOMAIN

    const cookies = await setCookiesFor('/clear', REFRESH_TOKEN_COOKIE)
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).not.toMatch(/Domain=/i)
  })
})

describe('auth.refresh (the wedged user)', () => {
  it('still evicts the host-only twin when the refresh token matches no Session', async () => {
    process.env.COOKIE_DOMAIN = '.clickroom.co'

    const res = await fetch(`${baseUrl}/refresh`, { method: 'POST' })
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' })

    const cookies = (res.headers.getSetCookie?.() ?? []).filter((raw) =>
      raw.startsWith(`${REFRESH_TOKEN_COOKIE}=`),
    )
    // The failing path never reaches `setRefreshCookie`, so this deletion is the
    // ONLY thing that un-wedges the user. Removing the try/catch in
    // `auth.router.ts` must fail here.
    expect(cookies).toHaveLength(1)
    expect(cookies[0] && isHostOnlyDeletion(cookies[0])).toBe(true)
  })

  it('with COOKIE_DOMAIN unset (dev), a failing refresh emits no cookie headers at all', async () => {
    delete process.env.COOKIE_DOMAIN

    const res = await fetch(`${baseUrl}/refresh`, { method: 'POST' })
    expect(res.status).toBe(401)
    expect(
      (res.headers.getSetCookie?.() ?? []).filter((raw) =>
        raw.startsWith(`${REFRESH_TOKEN_COOKIE}=`),
      ),
    ).toHaveLength(0)
  })
})
