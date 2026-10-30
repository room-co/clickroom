// Support config client + version gate + trigger evaluation + ticket-token store + context
// bundle assembly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildSupportContext,
  clearStoredTickets,
  createFormTelemetry,
  createSupportClient,
  EVENT_SUPPORT_CSAT,
  EVENT_SUPPORT_DEFLECTED,
  EVENT_SUPPORT_OPENED,
  EVENT_SUPPORT_SHOWN,
  findStoredTicket,
  forgetTicket,
  hasSelectorTrigger,
  initSupport,
  matchesEvent,
  matchesUrl,
  readStoredTickets,
  rememberTicket,
  SUPPORT_PROP_FORM_ID,
  SUPPORT_PROP_SCORE,
  type SupportClientDeps,
  type SupportDefinition,
  type SupportForm,
} from '../support'

// ---- in-memory localStorage stub ----------------------------------------

let storageMap: Map<string, string>

const makeStorage = (): Storage => {
  storageMap = new Map<string, string>()
  return {
    getItem: (k: string) => (storageMap.has(k) ? (storageMap.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      storageMap.set(k, String(v))
    },
    removeItem: (k: string) => {
      storageMap.delete(k)
    },
    key: (i: number) => Array.from(storageMap.keys())[i] ?? null,
    clear: () => storageMap.clear(),
    get length() {
      return storageMap.size
    },
  } as Storage
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---- fixtures ------------------------------------------------------------

const makeDefinition = (over: Partial<SupportDefinition> = {}): SupportDefinition => ({
  version: 1,
  channel: 'contact',
  fields: [{ id: 'email', type: 'email', label: 'Email', required: true }],
  sources: [],
  appearance: { layout: 'launcher', position: 'bottom_right' },
  tracking: {
    identity: true,
    formAnalytics: true,
    recentEvents: true,
    sessionReplay: false,
    bugContext: false,
  },
  routing: { destinations: [], autoReply: false },
  triggers: { showLauncher: true, autoOpen: false },
  ...over,
})

const makeForm = (over: Partial<SupportForm> = {}): SupportForm => ({
  id: 'sup_1',
  version: 1,
  linkedFlagKey: 'flag-1',
  definition: makeDefinition(),
  ...over,
})

const makeDeps = (
  over: Partial<SupportClientDeps> = {},
): SupportClientDeps & {
  captured: Array<{ event: string; props?: Record<string, unknown> }>
} => {
  const captured: Array<{ event: string; props?: Record<string, unknown> }> = []
  return {
    getApiHost: () => 'https://capture.example.com',
    getWriteKey: () => 'wk_test',
    isFeatureEnabled: () => true,
    capture: (event, props) => captured.push({ event, props }),
    getDistinctId: () => 'user-1',
    getPersonProperties: () => ({ plan: 'pro' }),
    getActiveFlags: () => ({ 'flag-1': true, beta: 'variant-a' }),
    now: () => 1_000_000,
    captured,
    ...over,
  }
}

/** Mock `fetch` returning `{ forms }` from `GET /v1/support`. */
const stubFormsFetch = (...responses: SupportForm[][]) => {
  let call = 0
  const mock = vi.fn(async () => {
    const forms = responses[Math.min(call, responses.length - 1)]
    call += 1
    return { ok: true, status: 200, json: async () => ({ forms }) }
  })
  vi.stubGlobal('fetch', mock as unknown as typeof fetch)
  return mock
}

// ---- config client + version gate ---------------------------------------

describe('support config client', () => {
  it('fetches GET /v1/support with the project write key', async () => {
    const fetchMock = stubFormsFetch([makeForm()])
    const client = createSupportClient(makeDeps())

    const forms = await client.fetchForms()

    expect(forms).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://capture.example.com/v1/support')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer wk_test')
  })

  it('drops malformed entries rather than failing the whole fetch', async () => {
    stubFormsFetch([
      makeForm(),
      { id: 'broken' } as unknown as SupportForm,
      makeForm({ id: 'sup_2', definition: undefined as unknown as SupportDefinition }),
    ])
    const client = createSupportClient(makeDeps())
    expect(await client.fetchForms()).toHaveLength(1)
  })

  it('persists the config to localStorage and restores it on a fresh client', async () => {
    stubFormsFetch([makeForm()])
    await createSupportClient(makeDeps()).fetchForms()

    expect(storageMap.has('ckrm_support')).toBe(true)
    // No fetch at all on the fresh client — the cache is read synchronously at construction.
    vi.stubGlobal('fetch', undefined)
    expect(createSupportClient(makeDeps()).getForms()).toHaveLength(1)
  })

  it('version gate: an unchanged config keeps the SAME array reference and skips the rewrite', async () => {
    stubFormsFetch([makeForm()], [makeForm()])
    const client = createSupportClient(makeDeps())

    const first = await client.fetchForms()
    storageMap.delete('ckrm_support')
    const second = await client.fetchForms()

    expect(second).toBe(first)
    // Short-circuited before the persist — nothing rewrote the cache we just deleted.
    expect(storageMap.has('ckrm_support')).toBe(false)
  })

  it('version gate: a bumped version replaces the cache and returns a NEW reference', async () => {
    stubFormsFetch([makeForm()], [makeForm({ version: 2 })])
    const client = createSupportClient(makeDeps())

    const first = await client.fetchForms()
    const second = await client.fetchForms()

    expect(second).not.toBe(first)
    expect(second[0].version).toBe(2)
  })

  it('falls back to the cached config on a non-ok response or a network error', async () => {
    stubFormsFetch([makeForm()])
    const client = createSupportClient(makeDeps())
    await client.fetchForms()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    )
    expect(await client.fetchForms()).toHaveLength(1)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch,
    )
    expect(await client.fetchForms()).toHaveLength(1)
  })
})

// ---- eligibility + trigger evaluation -----------------------------------

describe('trigger evaluation', () => {
  it('matchesUrl treats urlMatch as substring containment; absent = any URL', () => {
    const any = makeForm()
    expect(matchesUrl(any, 'https://app.example.com/anything')).toBe(true)

    const scoped = makeForm({
      definition: makeDefinition({
        triggers: { showLauncher: true, autoOpen: false, urlMatch: '/billing' },
      }),
    })
    expect(matchesUrl(scoped, 'https://app.example.com/billing/invoices')).toBe(true)
    expect(matchesUrl(scoped, 'https://app.example.com/settings')).toBe(false)
  })

  it('matchesEvent only fires for a declared trigger event', () => {
    const form = makeForm({
      definition: makeDefinition({
        triggers: { showLauncher: true, autoOpen: false, events: ['checkout_failed'] },
      }),
    })
    expect(matchesEvent(form, 'checkout_failed')).toBe(true)
    expect(matchesEvent(form, 'checkout_succeeded')).toBe(false)
    expect(matchesEvent(makeForm(), 'checkout_failed')).toBe(false)
  })

  it('hasSelectorTrigger reports a declared CSS selector', () => {
    expect(hasSelectorTrigger(makeForm())).toBe(false)
    expect(
      hasSelectorTrigger(
        makeForm({
          definition: makeDefinition({
            triggers: { showLauncher: true, autoOpen: false, selector: '#help' },
          }),
        }),
      ),
    ).toBe(true)
  })

  it('eligibility rides the linked flag; a null flag is always eligible', async () => {
    stubFormsFetch([
      makeForm({ id: 'on', linkedFlagKey: 'flag-on' }),
      makeForm({ id: 'off', linkedFlagKey: 'flag-off' }),
      makeForm({ id: 'always', linkedFlagKey: null }),
    ])
    const client = createSupportClient(makeDeps({ isFeatureEnabled: (key) => key === 'flag-on' }))
    await client.fetchForms()

    expect(client.getEligibleForms().map((f) => f.id)).toEqual(['on', 'always'])
    expect(client.formsForUrl('https://x.test/')).toHaveLength(2)
  })

  it('formsForEvent only returns eligible forms', async () => {
    const triggered = makeDefinition({
      triggers: { showLauncher: true, autoOpen: false, events: ['rage_click'] },
    })
    stubFormsFetch([
      makeForm({ id: 'on', linkedFlagKey: 'flag-on', definition: triggered }),
      makeForm({ id: 'off', linkedFlagKey: 'flag-off', definition: triggered }),
    ])
    const client = createSupportClient(makeDeps({ isFeatureEnabled: (k) => k === 'flag-on' }))
    await client.fetchForms()

    expect(client.formsForEvent('rage_click').map((f) => f.id)).toEqual(['on'])
    expect(client.formsForEvent('other')).toHaveLength(0)
  })
})

// ---- per-ticket token store ---------------------------------------------

describe('ticket-token store', () => {
  const ticket = (id: string, createdAt = 1) => ({
    id,
    number: 1,
    token: `tok-${id}`,
    formId: 'sup_1',
    createdAt,
  })

  it('remembers newest-first, de-dupes by id and finds by id', () => {
    rememberTicket(ticket('a'))
    rememberTicket(ticket('b'))
    expect(readStoredTickets().map((t) => t.id)).toEqual(['b', 'a'])

    rememberTicket({ ...ticket('a'), token: 'tok-a2' })
    expect(readStoredTickets().map((t) => t.id)).toEqual(['a', 'b'])
    expect(findStoredTicket('a')?.token).toBe('tok-a2')
    expect(findStoredTicket('missing')).toBeUndefined()
  })

  it('caps the store so a shared browser cannot grow it forever', () => {
    for (let i = 0; i < 30; i += 1) rememberTicket(ticket(`t${i}`))
    expect(readStoredTickets()).toHaveLength(20)
    expect(readStoredTickets()[0].id).toBe('t29')
  })

  it('forgets one credential and clears them all', () => {
    rememberTicket(ticket('a'))
    rememberTicket(ticket('b'))
    forgetTicket('a')
    expect(readStoredTickets().map((t) => t.id)).toEqual(['b'])
    clearStoredTickets()
    expect(readStoredTickets()).toEqual([])
  })

  it('survives a corrupt or non-array payload', () => {
    localStorage.setItem('ckrm_support_tickets', '{not json')
    expect(readStoredTickets()).toEqual([])
    localStorage.setItem('ckrm_support_tickets', '{"nope":1}')
    expect(readStoredTickets()).toEqual([])
    // Entries missing an id/token are dropped, valid siblings survive.
    localStorage.setItem('ckrm_support_tickets', JSON.stringify([{ id: 'x' }, ticket('ok')]))
    expect(readStoredTickets().map((t) => t.id)).toEqual(['ok'])
  })

  it('createTicket persists the returned token and getTicket presents it back', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/support/tickets')) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: 'tkt_1', number: 4821, token: 'secret' }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ id: 'tkt_1', messages: [] }) }
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const client = createSupportClient(makeDeps())

    const created = await client.createTicket({
      formId: 'sup_1',
      subject: 's',
      body: 'b',
    })
    expect(created?.number).toBe(4821)
    expect(findStoredTicket('tkt_1')?.token).toBe('secret')
    expect(client.getStoredTickets().map((t) => t.id)).toEqual(['tkt_1'])

    await client.getTicket('tkt_1')
    const readCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes('/v1/support/tickets/tkt_1'),
    ) as unknown as [string, RequestInit]
    expect((readCall[1].headers as Record<string, string>)['x-clickroom-ticket-token']).toBe(
      'secret',
    )
  })

  // ---- the new create keys ride a conditional spread ----
  //
  // `CreateTicketRequest` is `#[serde(deny_unknown_fields)]`, so a 0.9.0 client that unconditionally
  // sent `type`/`severity`/`bugReport` at an unpatched capture-rs would 400 on EVERY ticket. Omitting
  // them for a conversation caps the blast radius of a slipped deploy order to bug submissions.
  const stubCreateFetch = () => {
    const mock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: 'tkt_1', number: 1, token: 'secret' }),
    }))
    vi.stubGlobal('fetch', mock as unknown as typeof fetch)
    return mock
  }

  const createBody = (mock: ReturnType<typeof stubCreateFetch>): Record<string, unknown> => {
    const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit]
    return JSON.parse(String(init.body)) as Record<string, unknown>
  }

  it('createTicket omits type/severity/bugReport for a conversation', async () => {
    const fetchMock = stubCreateFetch()
    const client = createSupportClient(makeDeps())

    await client.createTicket({ formId: 'sup_1', subject: 's', body: 'b', category: 'Billing' })

    const body = createBody(fetchMock)
    expect(body.category).toBe('Billing')
    expect(body).not.toHaveProperty('type')
    expect(body).not.toHaveProperty('severity')
    expect(body).not.toHaveProperty('bugReport')
  })

  it('createTicket sends type/severity/bugReport for a bug', async () => {
    const fetchMock = stubCreateFetch()
    const client = createSupportClient(makeDeps())

    await client.createTicket({
      formId: 'sup_1',
      subject: 's',
      body: 'b',
      type: 'bug',
      severity: 'blocker',
      bugReport: {
        capturedAt: '2026-07-25T00:00:00.000Z',
        environment: { url: 'https://x.test/' },
      },
    })

    const body = createBody(fetchMock)
    expect(body.type).toBe('bug')
    expect(body.severity).toBe('blocker')
    expect(body.bugReport).toEqual({
      capturedAt: '2026-07-25T00:00:00.000Z',
      environment: { url: 'https://x.test/' },
    })
  })

  it('buildBugReport is always callable and clear() tears the capture back down', async () => {
    stubFormsFetch([makeForm()])
    const client = createSupportClient(makeDeps())
    // No DOM in this suite, so install/destroy are no-ops — the report still carries `capturedAt`.
    client.installBugCapture()
    expect(client.buildBugReport().capturedAt).toBeTruthy()
    expect(() => client.clear()).not.toThrow()
  })

  it('getTicket without a stored credential never hits the network, and a 401 drops it', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const client = createSupportClient(makeDeps())

    expect(await client.getTicket('nope')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()

    rememberTicket(ticket('tkt_1'))
    expect(await client.getTicket('tkt_1')).toBeNull()
    expect(findStoredTicket('tkt_1')).toBeUndefined()
  })

  it('clear() drops the config cache AND the token store', async () => {
    stubFormsFetch([makeForm()])
    const client = createSupportClient(makeDeps())
    await client.fetchForms()
    rememberTicket(ticket('a'))

    client.clear()

    expect(client.getForms()).toEqual([])
    expect(storageMap.has('ckrm_support')).toBe(false)
    expect(readStoredTickets()).toEqual([])
  })
})

// ---- context bundle ------------------------------------------------------

describe('context bundle', () => {
  const parts = {
    distinctId: 'user-1',
    personProperties: { plan: 'pro' },
    recentEvents: [{ event: '$pageview', timestamp: 'now' }],
    activeFlags: { beta: true },
    formAnalytics: {
      focusOrder: ['email'],
      editCounts: { email: 3 },
      timeToSubmitMs: 1200,
      droppedOffAt: null,
    },
  }

  it('includes every section when all toggles are on', () => {
    const ctx = buildSupportContext(
      { identity: true, formAnalytics: true, recentEvents: true, sessionReplay: false },
      parts,
    )
    expect(ctx.identity).toEqual({ distinctId: 'user-1', personProperties: { plan: 'pro' } })
    expect(ctx.recentEvents).toHaveLength(1)
    expect(ctx.activeFlags).toEqual({ beta: true })
    expect(ctx.formAnalytics?.editCounts.email).toBe(3)
  })

  it('OMITS a section whose toggle is off (absent ≠ empty)', () => {
    const ctx = buildSupportContext(
      { identity: false, formAnalytics: false, recentEvents: false, sessionReplay: false },
      parts,
    )
    expect(ctx.identity).toBeUndefined()
    expect(ctx.recentEvents).toBeUndefined()
    expect(ctx.activeFlags).toBeUndefined()
    expect(ctx.formAnalytics).toBeUndefined()
    expect(Object.keys(ctx)).toEqual([])
  })

  it('honours each toggle independently', () => {
    const onlyIdentity = buildSupportContext(
      { identity: true, formAnalytics: false, recentEvents: false, sessionReplay: false },
      parts,
    )
    expect(Object.keys(onlyIdentity)).toEqual(['identity'])

    const onlyEvents = buildSupportContext(
      { identity: false, formAnalytics: false, recentEvents: true, sessionReplay: false },
      parts,
    )
    expect(Object.keys(onlyEvents).sort()).toEqual(['activeFlags', 'recentEvents'])
  })

  it('defaults an absent/partial tracking config to everything-on', () => {
    const ctx = buildSupportContext(undefined, parts)
    expect(ctx.identity).toBeDefined()
    expect(ctx.recentEvents).toBeDefined()
    expect(ctx.formAnalytics).toBeDefined()
  })

  it('NEVER emits a sessionReplay section, even when the definition asks for one', () => {
    const ctx = buildSupportContext(
      { identity: true, formAnalytics: true, recentEvents: true, sessionReplay: true },
      parts,
    )
    expect(JSON.stringify(ctx)).not.toContain('sessionReplay')
  })

  it('client.buildContext reads the toggles off the form definition', async () => {
    stubFormsFetch([
      makeForm({
        definition: makeDefinition({
          tracking: {
            identity: false,
            formAnalytics: true,
            recentEvents: true,
            sessionReplay: false,
            bugContext: false,
          },
        }),
      }),
    ])
    const client = createSupportClient(makeDeps())
    const [form] = await client.fetchForms()

    client.recordEvent('checkout_started', { plan: 'pro' })
    const ctx = client.buildContext(form)

    expect(ctx.identity).toBeUndefined()
    expect(ctx.recentEvents?.[0].event).toBe('checkout_started')
    expect(ctx.activeFlags).toEqual({ 'flag-1': true, beta: 'variant-a' })
  })

  it('the recentEvents ring is capped and never remembers our own $support_* events', async () => {
    stubFormsFetch([makeForm()])
    const client = createSupportClient(makeDeps())
    const [form] = await client.fetchForms()

    for (let i = 0; i < 30; i += 1) client.recordEvent(`e${i}`)
    client.recordEvent(EVENT_SUPPORT_SHOWN)

    const events = client.buildContext(form).recentEvents ?? []
    expect(events).toHaveLength(20)
    expect(events[events.length - 1].event).toBe('e29')
    expect(events.some((e) => e.event.startsWith('$support_'))).toBe(false)
  })
})

// ---- form-fill telemetry -------------------------------------------------

describe('form telemetry', () => {
  it('records focus order, edit counts and time-to-submit', () => {
    let t = 1000
    const tel = createFormTelemetry(() => t)

    tel.focus('email')
    tel.edit('email')
    tel.edit('email')
    tel.focus('details')
    tel.focus('email') // re-focus does not reorder
    t = 4200
    tel.submit()

    const snap = tel.snapshot()
    expect(snap.focusOrder).toEqual(['email', 'details'])
    expect(snap.editCounts).toEqual({ email: 2 })
    expect(snap.timeToSubmitMs).toBe(3200)
    expect(snap.droppedOffAt).toBeNull()
  })

  it('reports the drop-off field when the form is abandoned', () => {
    const tel = createFormTelemetry(() => 0)
    tel.focus('email')
    tel.focus('details')

    expect(tel.snapshot()).toMatchObject({ timeToSubmitMs: null, droppedOffAt: 'details' })

    tel.reset()
    expect(tel.snapshot()).toEqual({
      focusOrder: [],
      editCounts: {},
      timeToSubmitMs: null,
      droppedOffAt: null,
    })
  })
})

// ---- capture -------------------------------------------------------------

describe('$support_* capture', () => {
  it('stamps $support_form_id on the client-side interactions', async () => {
    stubFormsFetch([makeForm()])
    const deps = makeDeps()
    const client = createSupportClient(deps)
    const [form] = await client.fetchForms()

    client.captureShown(form)
    client.captureOpened(form)
    client.captureDeflected(form)

    expect(deps.captured.map((c) => c.event)).toEqual([
      EVENT_SUPPORT_SHOWN,
      EVENT_SUPPORT_OPENED,
      EVENT_SUPPORT_DEFLECTED,
    ])
    for (const c of deps.captured) expect(c.props?.[SUPPORT_PROP_FORM_ID]).toBe('sup_1')
  })

  it('stringifies the CSAT score for the MV JSONExtractString → toInt8OrNull path', async () => {
    stubFormsFetch([makeForm()])
    const deps = makeDeps()
    const client = createSupportClient(deps)
    const [form] = await client.fetchForms()

    client.captureCsat(form, 4, 'tkt_1')

    const csat = deps.captured.find((c) => c.event === EVENT_SUPPORT_CSAT)
    expect(csat?.props?.[SUPPORT_PROP_SCORE]).toBe('4')
  })

  it('createTicket does NOT emit $support_ticket_created (capture-rs owns it server-side)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 201,
        json: async () => ({ id: 'tkt_1', number: 1, token: 'secret' }),
      })) as unknown as typeof fetch,
    )
    const deps = makeDeps()
    const client = createSupportClient(deps)

    await client.createTicket({ formId: 'sup_1', subject: 's', body: 'b' })

    expect(deps.captured).toEqual([])
  })
})

// ---- the user's own tickets: list + unread ---------------------

describe('listForUser / unread accessor', () => {
  const ticket = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    number: 1,
    token: `tok-${id}`,
    formId: 'sup_1',
    createdAt: 1,
    ...over,
  })

  /** A thread-read response for the anon per-ticket refresh; the id echoes the requested url. */
  const threadFetchMock = () =>
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: String(url).split('/').pop(),
        number: 1,
        formId: 'sup_1',
        status: 'open',
        subject: 'Refreshed subject',
        priority: 'normal',
        category: 'Question',
        createdAt: '2026-01-01T00:00:00Z',
        resolvedAt: null,
        messages: [],
      }),
    }))

  it('anonymous listForUser refetches per-ticket state and projects the local token store', async () => {
    rememberTicket(ticket('a'))
    rememberTicket(ticket('b'))
    // isIdentified absent = anonymous. Each stored thread is re-read (newest first) to freshen its
    // cached status/subject, then the local store is projected as the list.
    const fetchMock = threadFetchMock()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const client = createSupportClient(makeDeps())

    const list = await client.listForUser()

    expect(list.map((t) => t.id)).toEqual(['b', 'a'])
    // One thread read per stored ticket, freshened back into the cache.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(readStoredTickets().every((t) => t.status === 'open')).toBe(true)
    expect(list.find((t) => t.id === 'b')?.subject).toBe('Refreshed subject')
  })

  it('anonymous listForUser throttles the per-ticket refetch on rapid calls', async () => {
    rememberTicket(ticket('a'))
    // Fixed clock (`now: () => 1_000_000`) means a second call inside the throttle window is skipped.
    const fetchMock = threadFetchMock()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const client = createSupportClient(makeDeps())

    await client.listForUser()
    await client.listForUser()

    // Only the first pass fans out a thread read; the second is served from the just-refreshed cache.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('identified listForUser writes fresh server rows back onto the stored tokens', async () => {
    rememberTicket(ticket('dup', { unreadForUser: 0 }))
    const client = createSupportClient(makeDeps({ isIdentified: () => true }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          tickets: [
            {
              id: 'dup',
              number: 9,
              formId: 'sup_1',
              status: 'solved',
              subject: 'S',
              unreadForUser: 3,
            },
            // 'srv' has no local token — must never be created in the store (unreadable anyway).
            { id: 'srv', number: 5, formId: 'sup_1', status: 'open', unreadForUser: 1 },
          ],
        }),
      })) as unknown as typeof fetch,
    )

    await client.listForUser()

    const stored = readStoredTickets()
    expect(stored.map((t) => t.id)).toEqual(['dup']) // no credential-less 'srv' row created
    expect(stored[0].status).toBe('solved')
    expect(stored[0].subject).toBe('S')
    expect(stored[0].unreadForUser).toBe(3)
  })

  it('identified listForUser MERGES the server list with local this-browser tickets', async () => {
    rememberTicket(ticket('local'))
    const client = createSupportClient(makeDeps({ isIdentified: () => true }))

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          tickets: [{ id: 'srv', number: 9, formId: 'sup_1', unreadForUser: 4 }],
        }),
      })) as unknown as typeof fetch,
    )
    // Both the server row and the local this-browser ticket are present — an empty/partial server
    // response must never hide local history (the "Your conversations" row bug).
    expect(new Set((await client.listForUser()).map((t) => t.id))).toEqual(
      new Set(['srv', 'local']),
    )

    // A server failure degrades to the local store rather than throwing.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    )
    expect((await client.listForUser()).map((t) => t.id)).toEqual(['local'])
  })

  it('identified listForUser: an empty server list still keeps local tickets (row bug regression)', async () => {
    rememberTicket(ticket('local'))
    const client = createSupportClient(makeDeps({ isIdentified: () => true }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ tickets: [] }),
      })) as unknown as typeof fetch,
    )
    expect((await client.listForUser()).map((t) => t.id)).toEqual(['local'])
  })

  it('identified listForUser: server row WINS on id overlap (fresher unread/status)', async () => {
    rememberTicket(ticket('dup', { unreadForUser: 0 }))
    const client = createSupportClient(makeDeps({ isIdentified: () => true }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          tickets: [{ id: 'dup', number: 9, formId: 'sup_1', unreadForUser: 7 }],
        }),
      })) as unknown as typeof fetch,
    )
    const list = await client.listForUser()
    expect(list.map((t) => t.id)).toEqual(['dup'])
    expect(list[0].unreadForUser).toBe(7)
  })

  it('getUnreadCount sums unreadForUser off the stored tickets (drives the pill/badge)', () => {
    rememberTicket(ticket('a', { unreadForUser: 2 }))
    rememberTicket(ticket('b', { unreadForUser: 1 }))
    rememberTicket(ticket('c')) // absent = 0
    const client = createSupportClient(makeDeps())

    expect(client.getUnreadCount()).toBe(3)
  })

  it('reading a thread clears that ticket local unread', async () => {
    rememberTicket(ticket('a', { unreadForUser: 5 }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: 'a', messages: [] }),
      })) as unknown as typeof fetch,
    )
    const client = createSupportClient(makeDeps())

    expect(client.getUnreadCount()).toBe(5)
    await client.getTicket('a')
    expect(client.getUnreadCount()).toBe(0)
  })
})

// ---- realtime subscription: SSE + poll fallback -----------------

describe('subscribeTicket', () => {
  const ticket = () => ({ id: 'a', number: 1, token: 'tok-a', formId: 'sup_1', createdAt: 1 })

  it('parses an authorType:"ai" message off the thread read', async () => {
    rememberTicket(ticket())
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'a',
          number: 1,
          formId: 'sup_1',
          status: 'open',
          priority: 'normal',
          category: 'general',
          subject: 's',
          createdAt: 'now',
          resolvedAt: null,
          messages: [{ authorType: 'ai', body: 'bot reply', createdAt: 'now' }],
        }),
      })) as unknown as typeof fetch,
    )
    const client = createSupportClient(makeDeps())

    const thread = await client.getTicket('a')
    expect(thread?.messages[0].authorType).toBe('ai')
  })

  it('engages the poll fallback when EventSource is unavailable', async () => {
    vi.useFakeTimers()
    try {
      rememberTicket(ticket())
      // No EventSource in this runtime → the subscription degrades to a timer.
      vi.stubGlobal('EventSource', undefined)
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: 'a', messages: [] }),
      }))
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
      const client = createSupportClient(makeDeps())

      const seen: Array<unknown> = []
      const sub = client.subscribeTicket(
        'a',
        { onMessage: (t) => seen.push(t) },
        { pollIntervalMs: 3000 },
      )

      // Nothing before the first tick.
      expect(fetchMock).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(3000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(seen).toHaveLength(1)

      sub.unsubscribe()
      await vi.advanceTimersByTimeAsync(3000)
      // No further polls after unsubscribe.
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the SSE stream when EventSource exists and closes it on unsubscribe', () => {
    rememberTicket(ticket())
    const closed = { value: false }
    const listeners = new Map<string, () => void>()
    class FakeEventSource {
      url: string
      constructor(url: string) {
        this.url = url
      }
      addEventListener(type: string, cb: () => void) {
        listeners.set(type, cb)
      }
      close() {
        closed.value = true
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
    const client = createSupportClient(makeDeps())

    const sub = client.subscribeTicket('a', {})
    expect(listeners.has('message')).toBe(true)

    sub.unsubscribe()
    expect(closed.value).toBe(true)
  })

  it('returns an inert handle when no ticket credential is stored', () => {
    const client = createSupportClient(makeDeps())
    const sub = client.subscribeTicket('missing', {})
    expect(() => sub.unsubscribe()).not.toThrow()
  })
})

// ---- initSupport (data-only mode) ---------------------------------------

describe('initSupport', () => {
  it('warms the config cache and forwards captured events into the recentEvents ring', async () => {
    stubFormsFetch([makeForm()])
    const triggers: Array<(e: string, p?: Record<string, unknown>) => void> = []

    const client = initSupport({
      ...makeDeps(),
      render: null, // inert data-only mode — no DOM required
      registerEventTrigger: (t) => {
        triggers.push(t)
      },
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(client.getForms()).toHaveLength(1)
    expect(triggers).toHaveLength(1)
    triggers[0]('checkout_failed', { plan: 'pro' })
    expect(client.getRecentEvents().map((e) => e.event)).toEqual(['checkout_failed'])
  })
})

// ---- registerMountedHandles ---------------------------------------------
//
// The auto-mounted FAB's handle lives in this module's `mounted` map; without an accessor
// `clickroom.support.open()` can never reach it.

describe('initSupport mounted handles', () => {
  it('hands back the handles it auto-mounted, live', async () => {
    stubFormsFetch([makeForm()])
    const handle = { open: () => {}, close: () => {}, refresh: () => {}, destroy: () => {} }
    let getHandles: (() => unknown[]) | null = null

    initSupport({
      ...makeDeps(),
      render: () => handle,
      registerMountedHandles: (get) => {
        getHandles = get
      },
    })

    // Registered synchronously, before the config fetch settles — and empty until a form mounts.
    expect(getHandles).not.toBeNull()
    expect((getHandles as unknown as () => unknown[])()).toEqual([])

    await new Promise((r) => setTimeout(r, 0))
    expect((getHandles as unknown as () => unknown[])()).toEqual([handle])
  })
})
