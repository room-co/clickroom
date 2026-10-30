import type { Permission } from '@clickroom/auth'
import { requestContextStorage } from '@clickroom/db'
import type { TRPCError } from '@trpc/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Unit test — no Postgres, no ClickHouse. The scoped Prisma client is stubbed
// with in-memory tables so we can assert the linked-flag auto-create runs in one
// transaction, CRUD works, the ticket lifecycle stamps its timestamps exactly
// once, webhook deliveries are enqueued, and the RBAC->entitlement gate order
// holds. The real `EntitlementService` + `PLAN_FEATURES` make the plan decision.
// Same shape/mocking as `surveys.router.test.ts`.

// `webhooks.create` encrypts the generated secret with `encryptApiKey`, which
// fails closed when the key is unset — give it a valid 32-byte hex key.
process.env.AI_ENCRYPTION_KEY = '0'.repeat(64)

let currentPlanKey: string | null = null
let grantedPermissions: Set<Permission> = new Set()

// In-memory stores rebuilt each test.
type Row = Record<string, unknown>
let forms: Row[] = []
let tickets: Row[] = []
let messages: Row[] = []
let attachments: Row[] = []
let webhooks: Row[] = []
let deliveries: Row[] = []
let webhookAttempts: Row[] = []
let flags: Row[] = []
let flagAudits: Row[] = []
/** Every `$queryRaw`/`$executeRaw` the router issued, in order. */
let rawQueries: Array<{ sql: string; values: unknown[] }> = []
/** What the next `$queryRaw` hands back. */
let rawQueryResult: Row[] = []

type OrderBy = Record<string, 'asc' | 'desc'>

type FindManyArgs = {
  where?: Row
  // Prisma accepts a single object or an ordered list (multi-key sort with a
  // tiebreak, e.g. `webhooks.deliveries`) — the stub honours both.
  orderBy?: OrderBy | OrderBy[]
  take?: number
  skip?: number
  cursor?: { id: string }
}

function makeTable(store: () => Row[]) {
  return {
    create: async ({ data }: { data: Row }) => {
      const row = {
        createdAt: new Date(),
        ...data,
        version: (data.version as number) ?? 1,
      }
      store().push(row)
      return row
    },
    findFirst: async ({ where }: { where: Row }) => matchOne(store(), where),
    findFirstOrThrow: async ({ where }: { where: Row }) => {
      const row = matchOne(store(), where)
      if (!row) throw new Error('not found')
      return row
    },
    findMany: async (args: FindManyArgs = {}) => paginate(store(), args),
    count: async ({ where }: { where?: Row } = {}) =>
      store().filter((r) => matches(r, where ?? {})).length,
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const targets = store().filter((r) => matches(r, where))
      for (const r of targets) applyData(r, data)
      return { count: targets.length }
    },
    // Only the `by: [oneField] + _count: { _all: true }` shape the support router
    // uses (`results.volumeByType`) — not a general Prisma groupBy.
    groupBy: async ({ by, where }: { by: string[]; where?: Row }) => {
      const buckets = new Map<unknown, number>()
      for (const row of store().filter((r) => matches(r, where ?? {}))) {
        const key = row[by[0]]
        buckets.set(key, (buckets.get(key) ?? 0) + 1)
      }
      return [...buckets].map(([key, count]) => ({ [by[0]]: key, _count: { _all: count } }))
    },
  }
}

/** Order -> cursor -> skip -> take, mirroring Prisma's evaluation order. */
function paginate(rows: Row[], args: FindManyArgs) {
  let out = rows.filter((r) => matches(r, args.where ?? {}))
  const keys = (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy ?? {}]).flatMap((o) =>
    Object.entries(o),
  )
  if (keys.length > 0) {
    out = [...out].sort((a, b) => {
      for (const [field, dir] of keys) {
        const av = a[field] as string | number | Date
        const bv = b[field] as string | number | Date
        const cmp = av < bv ? -1 : av > bv ? 1 : 0
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp
      }
      return 0
    })
  }
  if (args.cursor) {
    const idx = out.findIndex((r) => r.id === args.cursor?.id)
    if (idx >= 0) out = out.slice(idx)
  }
  if (args.skip) out = out.slice(args.skip)
  if (args.take !== undefined) out = out.slice(0, args.take)
  return out
}

function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as Row)) {
      row[k] = (row[k] as number) + (v as { increment: number }).increment
    } else {
      row[k] = v
    }
  }
}

function matchOne(rows: Row[], where: Row) {
  return rows.find((r) => matches(r, where))
}

function matches(row: Row, where: Row) {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((sub) => matches(row, sub))
    return matchesOne(row[k], v)
  })
}

/** The subset of Prisma filter operators the support router actually uses. */
function matchesOne(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual === null || actual === undefined
  if (expected instanceof Date) return (actual as Date)?.getTime?.() === expected.getTime()
  if (typeof expected === 'object') {
    const f = expected as Row
    if ('in' in f) return (f.in as unknown[]).includes(actual)
    if ('has' in f) return Array.isArray(actual) && actual.includes(f.has)
    // Prisma's scalar-list emptiness test — the TS half of the empty-`events[]`
    // = subscribe-to-everything fix, matching `cardinality(...) = 0`
    // in both Rust readers.
    if ('isEmpty' in f) return Array.isArray(actual) && (actual.length === 0) === f.isEmpty
    // `webhooks.affectedForms`'s jsonb filter. This approximates Postgres `@>`
    // object containment over an array well enough to prove the router's
    // wiring and tenancy; the REAL containment semantics (and any Prisma
    // version drift in `array_contains`) can only be verified against a live
    // database, which this suite deliberately does not have.
    if ('path' in f && 'array_contains' in f) return jsonArrayContains(actual, f)
    // Relation filters, for the `7a` search (`attempts_: { some: … }`,
    // `ticket: { is: … }`). The delivery table hydrates both relations before
    // filtering — see `hydratedDeliveries`.
    if ('some' in f)
      return Array.isArray(actual) && actual.some((el) => matches(el as Row, f.some as Row))
    if ('is' in f) return actual != null && matches(actual as Row, f.is as Row)
    // Case-insensitive substring — the response-body half of the search.
    if ('contains' in f) {
      if (typeof actual !== 'string') return false
      const needle = String(f.contains)
      return f.mode === 'insensitive'
        ? actual.toLowerCase().includes(needle.toLowerCase())
        : actual.includes(needle)
    }
    if ('not' in f) return !matchesOne(actual, f.not)
    let ok = true
    if ('gte' in f) ok &&= (actual as Date) >= (f.gte as Date)
    if ('lte' in f) ok &&= (actual as Date) <= (f.lte as Date)
    // `attempts: { gt: 0 }` — the derived `'retrying'` filter's second half.
    if ('gt' in f) ok &&= (actual as number) > (f.gt as number)
    if ('lt' in f) ok &&= (actual as number) < (f.lt as number)
    return ok
  }
  return actual === expected
}

/** `{ path, array_contains }` over a jsonb column — see the caller's note. */
function jsonArrayContains(actual: unknown, filter: Row): boolean {
  const at = (filter.path as string[]).reduce<unknown>(
    (acc, key) => (acc as Row | undefined)?.[key],
    actual,
  )
  if (!Array.isArray(at)) return false
  return (filter.array_contains as Row[]).every((needle) =>
    at.some(
      (element) =>
        typeof element === 'object' &&
        element !== null &&
        Object.entries(needle).every(([k, v]) => (element as Row)[k] === v),
    ),
  )
}

// A support form's linked flag lives in EVERY environment (one row per env
// sharing a key), so the stub project has two.
const ENVIRONMENTS = [
  { id: 'env_1', key: 'production', isDefault: true },
  { id: 'env_2', key: 'development', isDefault: false },
]
const envForRow = (row: Row) =>
  ENVIRONMENTS.find((e) => e.id === row.environmentId) ?? ENVIRONMENTS[0]

const scopedClient = () => {
  const supportForm = makeTable(() => forms)
  const supportTicket = makeTable(() => tickets)
  const supportTicketMessage = makeTable(() => messages)
  const supportAttachment = makeTable(() => attachments)
  const supportWebhook = makeTable(() => webhooks)
  const deliveryTable = makeTable(() => deliveries)
  const supportWebhookAttempt = makeTable(() => webhookAttempts)
  // `webhooks.deliveries` asks for `include: { ticket, attempts_ }`, and the
  // `7a` search FILTERS on both relations (`ticket: { is: … }`,
  // `attempts_: { some: … }`). So reads run over a hydrated copy of the table —
  // the joins have to exist BEFORE `matches` sees the row, not be pasted on
  // afterwards. Writes still go through `deliveryTable`, which holds the real
  // mutable rows.
  const hydratedDeliveries = () =>
    deliveries.map((row) => {
      const ticket = tickets.find((t) => t.id === row.ticketId)
      return {
        ...row,
        ticket: ticket ? { number: ticket.number, subject: ticket.subject } : null,
        attempts_: webhookAttempts
          .filter((a) => a.deliveryId === row.id)
          .sort((a, b) => (b.attempt as number) - (a.attempt as number)),
      }
    })
  const hydratedTable = makeTable(hydratedDeliveries)
  const supportWebhookDelivery = {
    ...deliveryTable,
    findMany: hydratedTable.findMany,
    count: hydratedTable.count,
    groupBy: hydratedTable.groupBy,
  }
  const flagAudit = makeTable(() => flagAudits)
  const flagTable = makeTable(() => flags)
  // The support paths select `environment: { select: { id, key } }` on the flag
  // — the stub ignores `select`, so synthesize the joined relation on reads.
  const featureFlag = {
    ...flagTable,
    findFirst: async (args: { where: Row }) => {
      const row = await flagTable.findFirst(args)
      return row ? { ...row, environment: envForRow(row) } : row
    },
    findMany: async (args?: FindManyArgs) => {
      const rows = await flagTable.findMany(args)
      return rows.map((r) => ({ ...r, environment: envForRow(r) }))
    },
  }
  // `health`/`stats`/`reEnableAndReplay` are `$queryRaw`/`$executeRaw` — there
  // is NO SQL engine here, so the stub records the statement and its binds and
  // returns whatever the test parked in `rawQueryResult`. See the note on the
  // `raw-SQL surfaces` describe block: these are wiring/tenancy assertions, not
  // behavioural ones.
  const rawTables = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      rawQueries.push({ sql: strings.join('?'), values })
      return rawQueryResult
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      rawQueries.push({ sql: strings.join('?'), values })
      return 0
    },
  }
  const tables = {
    ...rawTables,
    supportForm,
    supportTicket,
    supportTicketMessage,
    supportAttachment,
    supportWebhook,
    supportWebhookDelivery,
    supportWebhookAttempt,
    featureFlag,
    flagAudit,
  }
  return {
    org: { findUnique: async () => orgRow(), findFirst: async () => orgRow() },
    project: { findFirst: async () => ({ id: 'proj_1', orgId: 'org_1' }) },
    environment: {
      findFirst: async ({ where }: { where?: Row } = {}) =>
        where?.isDefault ? ENVIRONMENTS.find((e) => e.isDefault) : ENVIRONMENTS[0],
      findFirstOrThrow: async () => ENVIRONMENTS[0],
      findMany: async () => ENVIRONMENTS.map((e) => ({ ...e })),
    },
    ...tables,
    // Sequential in-memory transaction — the callback runs against the same
    // stubbed tables, so a failure surfaces synchronously in the test.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tables),
  }
}

vi.mock('@clickroom/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clickroom/db')>()
  return {
    ...actual,
    prisma: {} as unknown,
    createScopedClient: () => scopedClient(),
  }
})

vi.mock('@clickroom/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clickroom/auth')>()
  return {
    ...actual,
    can: (_role: string, perm: Permission) => grantedPermissions.has(perm),
  }
})

// Redis-backed cache helpers are no-ops here — we assert on the Postgres writes.
vi.mock('../../lib/redis.js', () => ({
  redis: { publish: async () => 0 },
  cacheSetJson: async () => undefined,
}))

// `webhooks.sendTest` runs the real `admitWebhookUrl` SSRF guard, which resolves
// the endpoint's hostname. Stub the resolver so the suite neither needs DNS nor
// depends on what a public name happens to resolve to today; each test decides
// what the host resolves to, which is exactly the knob the guard turns on.
let resolvedAddresses: string[] = ['93.184.216.34']
vi.mock('node:dns/promises', () => ({
  lookup: async () => resolvedAddresses.map((address) => ({ address, family: 4 })),
}))

function orgRow() {
  return { plan: currentPlanKey ? { key: currentPlanKey } : null }
}

const { appRouter } = await import('../app.router.js')

type AppContext = Parameters<typeof appRouter.createCaller>[0]

function caller() {
  return appRouter.createCaller({
    tokenPayload: { sub: 'user_1', sessionId: 'test', orgId: 'org_1' },
  } as unknown as AppContext)
}

function run<T>(fn: () => Promise<T>) {
  return requestContextStorage.run(
    { userId: 'user_1', orgId: 'org_1', orgRole: 'org_admin', authSource: 'jwt' },
    fn,
  )
}

const DEFINITION = {
  version: 1 as const,
  channel: 'contact' as const,
  // Subject + Message are structural (always rendered by the widget, validated by capture-rs) —
  // `fields` holds only extra custom fields, never a declared subject/body.
  fields: [
    { type: 'email' as const, id: 'email', label: 'Email', required: true },
    {
      type: 'dropdown' as const,
      id: 'category',
      label: 'Topic',
      required: false,
      choices: ['Billing', 'Bug'],
    },
  ],
  sources: [],
  appearance: { layout: 'launcher' as const, position: 'bottom_right' as const },
  tracking: { identity: true, formAnalytics: true, recentEvents: true, sessionReplay: false },
  routing: { destinations: [], autoReply: false },
  triggers: { showLauncher: true, autoOpen: false },
}

const RANGE = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' }

/** Seed a ticket directly — creation is capture-rs's job, not tRPC's. */
function seedTicket(overrides: Row = {}) {
  const row: Row = {
    id: 'tkt_1',
    formId: 'form_1',
    projectId: 'proj_1',
    number: 1,
    distinctId: 'anon_1',
    personId: null,
    status: 'open',
    priority: 'normal',
    type: 'conversation',
    severity: null,
    bugReport: null,
    category: 'billing',
    subject: 'Help',
    assigneeId: null,
    token: 'tok_1',
    fields: {},
    context: { identity: { email: 'a@b.co' } },
    firstReplyAt: null,
    resolvedAt: null,
    unreadForUser: 0,
    unreadForAgent: 0,
    createdAt: new Date('2026-01-05T00:00:00.000Z'),
    updatedAt: new Date('2026-01-05T00:00:00.000Z'),
    ...overrides,
  }
  tickets.push(row)
  return row
}

beforeEach(() => {
  currentPlanKey = 'pro'
  grantedPermissions = new Set<Permission>(['projects:read', 'projects:manage'])
  forms = []
  tickets = []
  messages = []
  attachments = []
  webhooks = []
  deliveries = []
  webhookAttempts = []
  resolvedAddresses = ['93.184.216.34']
  flags = []
  flagAudits = []
  rawQueries = []
  rawQueryResult = []
})

describe('support.create', () => {
  it('auto-creates a linked boolean flag per environment in one transaction', async () => {
    const form = await run(() =>
      caller().support.create({ projectId: 'proj_1', name: 'Contact us', definition: DEFINITION }),
    )

    expect(form).toMatchObject({ name: 'Contact us', status: 'draft', version: 1 })
    expect(form.createdBy).toBe('user_1')

    expect(flags).toHaveLength(2)
    const keys = new Set(flags.map((f) => String(f.key)))
    expect(keys.size).toBe(1)
    const [onlyKey] = [...keys]
    expect(onlyKey).toMatch(/^support-contact-us-/)
    expect(new Set(flags.map((f) => f.environmentId))).toEqual(new Set(['env_1', 'env_2']))
    for (const flag of flags) {
      expect(flag.active).toBe(false)
      expect(flag.track).toBe(false)
      expect((flag.filters as { kind: string }).kind).toBe('boolean')
    }

    // The form points at the DEFAULT environment's (env_1) row.
    expect(form.featureFlagId).toBe(flags.find((f) => f.environmentId === 'env_1')?.id)

    expect(flagAudits).toHaveLength(2)
    expect(flagAudits.every((a) => a.action === 'created')).toBe(true)
  })

  it("round-trips channel:'bot' unchanged (builder saves it, SDK treats it as contact)", async () => {
    const form = await run(() =>
      caller().support.create({
        projectId: 'proj_1',
        name: 'Bot',
        definition: { ...DEFINITION, channel: 'bot' as const },
      }),
    )
    expect((form.definition as { channel: string }).channel).toBe('bot')
  })
})

describe('support form CRUD', () => {
  it('lists, gets, and filters by status', async () => {
    await run(() =>
      caller().support.create({ projectId: 'proj_1', name: 'A', definition: DEFINITION }),
    )
    const list = await run(() => caller().support.list({ projectId: 'proj_1' }))
    expect(list).toHaveLength(1)

    const got = await run(() => caller().support.get({ projectId: 'proj_1', id: list[0].id }))
    expect(got.name).toBe('A')

    const active = await run(() => caller().support.list({ projectId: 'proj_1', status: 'active' }))
    expect(active).toHaveLength(0)
  })

  it('bumps version on a definition edit but not on a status-only edit', async () => {
    const created = await run(() =>
      caller().support.create({ projectId: 'proj_1', name: 'A', definition: DEFINITION }),
    )
    expect(created.version).toBe(1)

    const activated = await run(() =>
      caller().support.update({ projectId: 'proj_1', id: created.id, patch: { status: 'active' } }),
    )
    expect(activated).toMatchObject({ status: 'active', version: 1 })

    const edited = await run(() =>
      caller().support.update({
        projectId: 'proj_1',
        id: created.id,
        patch: { definition: DEFINITION },
      }),
    )
    expect(edited.version).toBe(2)
  })

  it("drives EVERY environment's linked flag active from a status change", async () => {
    const created = await run(() =>
      caller().support.create({ projectId: 'proj_1', name: 'A', definition: DEFINITION }),
    )
    expect(flags.every((f) => f.active === false)).toBe(true)

    await run(() =>
      caller().support.update({ projectId: 'proj_1', id: created.id, patch: { status: 'active' } }),
    )
    expect(flags.every((f) => f.active === true)).toBe(true)
    expect(flags.every((f) => f.version === 2)).toBe(true)
    for (const f of flags) {
      expect(flagAudits.some((a) => a.action === 'updated' && a.flagId === f.id)).toBe(true)
    }

    await run(() =>
      caller().support.update({
        projectId: 'proj_1',
        id: created.id,
        patch: { status: 'archived' },
      }),
    )
    expect(flags.every((f) => f.active === false)).toBe(true)
  })

  it('does not churn the linked flag on a non-status edit', async () => {
    const created = await run(() =>
      caller().support.create({ projectId: 'proj_1', name: 'A', definition: DEFINITION }),
    )
    const flagVersion = flags[0].version
    const auditCount = flagAudits.length

    await run(() =>
      caller().support.update({ projectId: 'proj_1', id: created.id, patch: { name: 'B' } }),
    )
    expect(flags[0].version).toBe(flagVersion)
    expect(flagAudits).toHaveLength(auditCount)
  })

  it('soft-deletes the form and every linked flag', async () => {
    const created = await run(() =>
      caller().support.create({ projectId: 'proj_1', name: 'A', definition: DEFINITION }),
    )
    const res = await run(() => caller().support.delete({ projectId: 'proj_1', id: created.id }))
    expect(res).toEqual({ id: created.id, deleted: true })

    expect(forms[0].deletedAt).toBeInstanceOf(Date)
    expect(flags.every((f) => f.deletedAt instanceof Date)).toBe(true)
    for (const f of flags) {
      expect(flagAudits.some((a) => a.action === 'deleted' && a.flagId === f.id)).toBe(true)
    }
  })

  it('throws NOT_FOUND getting a missing form', async () => {
    const err = await run(() =>
      caller()
        .support.get({ projectId: 'proj_1', id: 'nope' })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).code).toBe('NOT_FOUND')
  })
})

describe('support entitlement + RBAC gates', () => {
  it('denies a free org with not_entitled / support', async () => {
    currentPlanKey = 'free'
    const err = await run(() =>
      caller()
        .support.list({ projectId: 'proj_1' })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).code).toBe('FORBIDDEN')
    expect((err as TRPCError).cause).toMatchObject({ code: 'not_entitled', feature: 'support' })
  })

  it('returns the permissions error, not the entitlement error, without projects:manage', async () => {
    grantedPermissions = new Set<Permission>(['projects:read'])
    const err = await run(() =>
      caller()
        .support.create({ projectId: 'proj_1', name: 'A', definition: DEFINITION })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).code).toBe('FORBIDDEN')
    expect((err as TRPCError).message).toBe('Insufficient permissions.')
    expect(flags).toHaveLength(0)
  })

  it('gates ticket writes on projects:manage', async () => {
    grantedPermissions = new Set<Permission>(['projects:read'])
    seedTicket()
    const err = await run(() =>
      caller()
        .support.tickets.reply({ projectId: 'proj_1', id: 'tkt_1', body: 'hi' })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).message).toBe('Insufficient permissions.')
    expect(messages).toHaveLength(0)
  })

  it('gates webhook reads on the entitlement', async () => {
    currentPlanKey = 'free'
    const err = await run(() =>
      caller()
        .support.webhooks.list({ projectId: 'proj_1' })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).cause).toMatchObject({ code: 'not_entitled', feature: 'support' })
  })

  it('results.* are entitlement-gated before any ClickHouse read', async () => {
    currentPlanKey = 'free'
    const err = await run(() =>
      caller()
        .support.results.deflectionRate({ projectId: 'proj_1', formId: 'form_1', range: RANGE })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).cause).toMatchObject({ code: 'not_entitled', feature: 'support' })
  })
})

describe('support.tickets lifecycle', () => {
  it('lists with filters and paginates by cursor', async () => {
    seedTicket({ id: 't1', createdAt: new Date('2026-01-01T00:00:00.000Z') })
    seedTicket({ id: 't2', createdAt: new Date('2026-01-02T00:00:00.000Z'), status: 'resolved' })
    seedTicket({ id: 't3', createdAt: new Date('2026-01-03T00:00:00.000Z'), category: 'bug' })

    const all = await run(() => caller().support.tickets.list({ projectId: 'proj_1', limit: 20 }))
    expect(all.items.map((t) => t.id)).toEqual(['t3', 't2', 't1'])
    expect(all.nextCursor).toBeNull()

    const open = await run(() =>
      caller().support.tickets.list({ projectId: 'proj_1', status: 'open', limit: 20 }),
    )
    expect(open.items.map((t) => t.id)).toEqual(['t3', 't1'])

    const byCategory = await run(() =>
      caller().support.tickets.list({ projectId: 'proj_1', category: 'bug', limit: 20 }),
    )
    expect(byCategory.items).toHaveLength(1)

    const firstPage = await run(() =>
      caller().support.tickets.list({ projectId: 'proj_1', limit: 2 }),
    )
    expect(firstPage.items.map((t) => t.id)).toEqual(['t3', 't2'])
    expect(firstPage.nextCursor).toBe('t2')

    const secondPage = await run(() =>
      caller().support.tickets.list({
        projectId: 'proj_1',
        limit: 2,
        cursor: firstPage.nextCursor,
      }),
    )
    expect(secondPage.items.map((t) => t.id)).toEqual(['t1'])
  })

  it('returns the ticket, its thread and its context bundle', async () => {
    seedTicket()
    messages.push({ id: 'm1', ticketId: 'tkt_1', authorType: 'user', body: 'hello' })
    const res = await run(() => caller().support.tickets.get({ projectId: 'proj_1', id: 'tkt_1' }))
    expect(res.ticket.id).toBe('tkt_1')
    expect(res.messages).toHaveLength(1)
    expect(res.context).toMatchObject({ identity: { email: 'a@b.co' } })
  })

  it('stamps firstReplyAt on the FIRST reply only and enqueues ticket.replied', async () => {
    seedTicket()
    webhooks.push({
      id: 'wh_1',
      projectId: 'proj_1',
      url: 'https://example.com/hook',
      secret: 'enc',
      events: ['ticket.replied'],
      active: true,
      deletedAt: null,
    })

    const first = await run(() =>
      caller().support.tickets.reply({ projectId: 'proj_1', id: 'tkt_1', body: 'On it' }),
    )
    expect(first.firstReply).toBe(true)
    expect(first.message.authorType).toBe('agent')
    expect(first.message.authorUserId).toBe('user_1')
    const stamped = tickets[0].firstReplyAt as Date
    expect(stamped).toBeInstanceOf(Date)

    // One pending delivery per subscribed webhook.
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      webhookId: 'wh_1',
      ticketId: 'tkt_1',
      event: 'ticket.replied',
      status: 'pending',
      attempts: 0,
    })

    const second = await run(() =>
      caller().support.tickets.reply({ projectId: 'proj_1', id: 'tkt_1', body: 'Any update?' }),
    )
    expect(second.firstReply).toBe(false)
    // The metric input is never overwritten by a later reply.
    expect(tickets[0].firstReplyAt).toBe(stamped)
    expect(messages).toHaveLength(2)
    expect(deliveries).toHaveLength(2)
  })

  it('does not enqueue when no webhook subscribes to the event', async () => {
    seedTicket()
    webhooks.push({
      id: 'wh_1',
      projectId: 'proj_1',
      url: 'https://example.com/hook',
      secret: 'enc',
      events: ['ticket.created'],
      active: true,
      deletedAt: null,
    })
    await run(() =>
      caller().support.tickets.reply({ projectId: 'proj_1', id: 'tkt_1', body: 'hi' }),
    )
    expect(deliveries).toHaveLength(0)
  })

  it('stamps resolvedAt on resolve, keeps it on close, clears it on reopen', async () => {
    seedTicket()
    const resolved = await run(() =>
      caller().support.tickets.setStatus({ projectId: 'proj_1', id: 'tkt_1', status: 'resolved' }),
    )
    expect(resolved.status).toBe('resolved')
    const at = resolved.resolvedAt as Date
    expect(at).toBeInstanceOf(Date)

    const closed = await run(() =>
      caller().support.tickets.setStatus({ projectId: 'proj_1', id: 'tkt_1', status: 'closed' }),
    )
    expect(closed.resolvedAt).toEqual(at)

    const reopened = await run(() =>
      caller().support.tickets.setStatus({ projectId: 'proj_1', id: 'tkt_1', status: 'open' }),
    )
    expect(reopened.resolvedAt).toBeNull()
  })

  it('enqueues ticket.reopened when a terminal ticket moves back out', async () => {
    seedTicket({ status: 'resolved', resolvedAt: new Date('2026-01-06T00:00:00.000Z') })
    webhooks.push({
      id: 'wh_1',
      projectId: 'proj_1',
      url: 'https://example.com/hook',
      secret: 'enc',
      events: ['ticket.reopened'],
      active: true,
      deletedAt: null,
    })

    await run(() =>
      caller().support.tickets.setStatus({ projectId: 'proj_1', id: 'tkt_1', status: 'open' }),
    )

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      webhookId: 'wh_1',
      ticketId: 'tkt_1',
      event: 'ticket.reopened',
      status: 'pending',
    })
  })

  it('does not emit ticket.reopened for a live -> live transition', async () => {
    seedTicket({ status: 'open' })
    webhooks.push({
      id: 'wh_1',
      projectId: 'proj_1',
      url: 'https://example.com/hook',
      secret: 'enc',
      events: ['ticket.reopened', 'ticket.resolved'],
      active: true,
      deletedAt: null,
    })
    await run(() =>
      caller().support.tickets.setStatus({ projectId: 'proj_1', id: 'tkt_1', status: 'pending' }),
    )
    expect(deliveries).toHaveLength(0)
  })

  it('assigns and unassigns a ticket', async () => {
    seedTicket()
    const assigned = await run(() =>
      caller().support.tickets.assign({ projectId: 'proj_1', id: 'tkt_1', assigneeId: 'user_9' }),
    )
    expect(assigned.assigneeId).toBe('user_9')

    const cleared = await run(() =>
      caller().support.tickets.assign({ projectId: 'proj_1', id: 'tkt_1', assigneeId: null }),
    )
    expect(cleared.assigneeId).toBeNull()
  })

  it('throws NOT_FOUND replying to a missing ticket', async () => {
    const err = await run(() =>
      caller()
        .support.tickets.reply({ projectId: 'proj_1', id: 'nope', body: 'hi' })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).code).toBe('NOT_FOUND')
  })
})

describe('support.tickets end-user surface', () => {
  it("listForUser returns only the identified user's own tickets", async () => {
    seedTicket({ id: 'mine_1', distinctId: 'anon_1' })
    seedTicket({
      id: 'mine_2',
      distinctId: 'anon_1',
      createdAt: new Date('2026-01-06T00:00:00.000Z'),
    })
    seedTicket({ id: 'theirs', distinctId: 'anon_2' })

    const res = await run(() =>
      caller().support.tickets.listForUser({
        projectId: 'proj_1',
        distinctId: 'anon_1',
        limit: 20,
      }),
    )
    expect(res.items.map((r) => r.id).sort()).toEqual(['mine_1', 'mine_2'])
    expect(res.items.some((r) => r.id === 'theirs')).toBe(false)
  })

  it('listForUser also matches by personId once the user is logged in', async () => {
    seedTicket({ id: 'by_distinct', distinctId: 'anon_1' })
    seedTicket({ id: 'by_person', distinctId: 'anon_other', personId: 'person_1' })
    seedTicket({ id: 'unrelated', distinctId: 'anon_x', personId: 'person_2' })

    const res = await run(() =>
      caller().support.tickets.listForUser({
        projectId: 'proj_1',
        distinctId: 'anon_1',
        personId: 'person_1',
        limit: 20,
      }),
    )
    expect(res.items.map((r) => r.id).sort()).toEqual(['by_distinct', 'by_person'])
  })

  it('listForUser row carries the 2a shape (chip label + snippet + unread)', async () => {
    seedTicket({ id: 'tkt_1', status: 'open', unreadForUser: 2 })
    messages.push({
      id: 'm1',
      ticketId: 'tkt_1',
      authorType: 'agent',
      body: 'We are on it, thanks for reaching out.',
      createdAt: new Date('2026-01-05T00:10:00.000Z'),
    })

    const res = await run(() =>
      caller().support.tickets.listForUser({
        projectId: 'proj_1',
        distinctId: 'anon_1',
        limit: 20,
      }),
    )
    const [row] = res.items
    expect(row).toMatchObject({
      id: 'tkt_1',
      number: 1,
      subject: 'Help',
      category: 'billing',
      status: 'open',
      statusLabel: 'Agent replied',
      lastAuthorType: 'agent',
      unreadForUser: 2,
      type: 'conversation',
    })
    expect(row.snippet).toBe('Support: We are on it, thanks for reaching out.')
    expect(typeof row.relativeTime).toBe('string')
  })

  it('listForUser row carries `type` so a bug row can be chipped — ONE list, same order', async () => {
    seedTicket({ id: 'bug_1', type: 'bug', createdAt: new Date('2026-01-05T00:02:00.000Z') })
    seedTicket({ id: 'convo_1', type: 'conversation' })

    const res = await run(() =>
      caller().support.tickets.listForUser({
        projectId: 'proj_1',
        distinctId: 'anon_1',
        limit: 20,
      }),
    )
    // Same single list, same createdAt-desc ordering — only the discriminator is new.
    expect(res.items.map((r) => r.id)).toEqual(['bug_1', 'convo_1'])
    expect(res.items.map((r) => r.type)).toEqual(['bug', 'conversation'])
    // Statuses do NOT fork (hard constraint 4).
    expect(res.items.map((r) => r.statusLabel)).toEqual(['Waiting on us', 'Waiting on us'])
  })

  it('thread returns the shared TicketMessage[] for the requester and for an agent', async () => {
    seedTicket({ distinctId: 'anon_1' })
    messages.push({
      id: 'm1',
      ticketId: 'tkt_1',
      authorType: 'user',
      body: 'hi',
      createdAt: new Date('2026-01-05T00:01:00.000Z'),
    })
    messages.push({
      id: 'm2',
      ticketId: 'tkt_1',
      authorType: 'agent',
      body: 'hello',
      createdAt: new Date('2026-01-05T00:02:00.000Z'),
    })

    // Requester (matching distinctId) can read.
    const asUser = await run(() =>
      caller().support.tickets.thread({ projectId: 'proj_1', id: 'tkt_1', distinctId: 'anon_1' }),
    )
    expect(asUser.messages.map((m) => m.id)).toEqual(['m1', 'm2'])

    // Agent read (no distinctId) can read too.
    const asAgent = await run(() =>
      caller().support.tickets.thread({ projectId: 'proj_1', id: 'tkt_1' }),
    )
    expect(asAgent.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('thread denies a different end-user (wrong distinctId)', async () => {
    seedTicket({ distinctId: 'anon_1' })
    messages.push({ id: 'm1', ticketId: 'tkt_1', authorType: 'user', body: 'hi' })

    const err = await run(() =>
      caller()
        .support.tickets.thread({ projectId: 'proj_1', id: 'tkt_1', distinctId: 'anon_2' })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).code).toBe('NOT_FOUND')
  })

  it('reply increments unreadForUser on every agent message', async () => {
    seedTicket({ unreadForUser: 0 })
    await run(() =>
      caller().support.tickets.reply({ projectId: 'proj_1', id: 'tkt_1', body: 'one' }),
    )
    expect(tickets[0].unreadForUser).toBe(1)
    await run(() =>
      caller().support.tickets.reply({ projectId: 'proj_1', id: 'tkt_1', body: 'two' }),
    )
    expect(tickets[0].unreadForUser).toBe(2)
  })

  it('get clears unreadForAgent when the agent opens the ticket', async () => {
    seedTicket({ unreadForAgent: 3 })
    const res = await run(() => caller().support.tickets.get({ projectId: 'proj_1', id: 'tkt_1' }))
    expect(res.ticket.unreadForAgent).toBe(0)
    expect(tickets[0].unreadForAgent).toBe(0)
  })

  it('markSolved stamps resolvedAt and sets status=resolved (same as setStatus)', async () => {
    seedTicket({ status: 'open', resolvedAt: null })
    const solved = await run(() =>
      caller().support.tickets.markSolved({ projectId: 'proj_1', id: 'tkt_1' }),
    )
    expect(solved.status).toBe('resolved')
    expect(solved.resolvedAt).toBeInstanceOf(Date)
  })

  it('markSolved is gated on projects:manage', async () => {
    grantedPermissions = new Set<Permission>(['projects:read'])
    seedTicket()
    const err = await run(() =>
      caller()
        .support.tickets.markSolved({ projectId: 'proj_1', id: 'tkt_1' })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).message).toBe('Insufficient permissions.')
    expect(tickets[0].status).toBe('open')
  })

  it('maps ticket status to the end-user chip label', async () => {
    const { endUserStatusLabel } = await import('./support.router.js')
    expect(endUserStatusLabel('resolved', null)).toBe('Solved')
    expect(endUserStatusLabel('closed', 'user')).toBe('Solved')
    expect(endUserStatusLabel('open', 'agent')).toBe('Agent replied')
    expect(endUserStatusLabel('pending', 'ai')).toBe('Agent replied')
    expect(endUserStatusLabel('open', 'user')).toBe('Waiting on us')
    expect(endUserStatusLabel('pending', null)).toBe('Waiting on us')
  })

  it("accepts authorType 'ai' through the message-author zod union", async () => {
    const { supportMessageAuthorTypeSchema } = await import('./support.schema.js')
    expect(supportMessageAuthorTypeSchema.parse('ai')).toBe('ai')
    for (const t of ['user', 'agent', 'system'] as const) {
      expect(supportMessageAuthorTypeSchema.parse(t)).toBe(t)
    }
    expect(() => supportMessageAuthorTypeSchema.parse('bogus')).toThrow()
  })
})

describe('support.tickets bug/conversation split', () => {
  it('ticketListWhere emits type and severity with the same !== undefined guard', async () => {
    const { ticketListWhere } = await import('./support.router.js')

    // Absent -> no predicate at all (the inbox's "All" tab), byte-identical to
    // the pre-phase call shape.
    expect(ticketListWhere({ formId: 'form_1' })).toEqual({ formId: 'form_1' })

    expect(ticketListWhere({ type: 'bug', severity: 'blocker' })).toEqual({
      type: 'bug',
      severity: 'blocker',
    })

    // Composes with the existing filters rather than replacing them.
    expect(
      ticketListWhere({
        formId: 'form_1',
        status: 'open',
        type: 'bug',
        severity: 'major',
        category: 'billing',
        assigneeId: 'user_9',
      }),
    ).toEqual({
      formId: 'form_1',
      status: 'open',
      type: 'bug',
      severity: 'major',
      category: 'billing',
      assigneeId: 'user_9',
    })
  })

  it('list filters by type and by severity end-to-end', async () => {
    seedTicket({ id: 'c1', type: 'conversation' })
    seedTicket({ id: 'b1', type: 'bug', severity: 'blocker' })
    seedTicket({ id: 'b2', type: 'bug', severity: 'minor' })

    const all = await run(() => caller().support.tickets.list({ projectId: 'proj_1', limit: 20 }))
    expect(all.items).toHaveLength(3)

    const bugs = await run(() =>
      caller().support.tickets.list({ projectId: 'proj_1', type: 'bug', limit: 20 }),
    )
    expect(bugs.items.map((t) => t.id).sort()).toEqual(['b1', 'b2'])

    const blockers = await run(() =>
      caller().support.tickets.list({
        projectId: 'proj_1',
        type: 'bug',
        severity: 'blocker',
        limit: 20,
      }),
    )
    expect(blockers.items.map((t) => t.id)).toEqual(['b1'])
  })

  it('list rows carry type and severity for the inbox columns', async () => {
    seedTicket({ id: 'b1', type: 'bug', severity: 'major' })
    const res = await run(() => caller().support.tickets.list({ projectId: 'proj_1', limit: 20 }))
    expect(res.items[0]).toMatchObject({ type: 'bug', severity: 'major' })
  })

  it('setPriority writes the column an agent surface could never write before', async () => {
    seedTicket({ priority: 'normal' })
    const res = await run(() =>
      caller().support.tickets.setPriority({
        projectId: 'proj_1',
        id: 'tkt_1',
        priority: 'urgent',
      }),
    )
    expect(res.priority).toBe('urgent')
    expect(tickets[0].priority).toBe('urgent')
  })

  it('setPriority is gated on projects:manage', async () => {
    grantedPermissions = new Set<Permission>(['projects:read'])
    seedTicket()
    const err = await run(() =>
      caller()
        .support.tickets.setPriority({ projectId: 'proj_1', id: 'tkt_1', priority: 'high' })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).message).toBe('Insufficient permissions.')
    expect(tickets[0].priority).toBe('normal')
  })

  it('setSeverity sets and clears severity on a bug', async () => {
    seedTicket({ type: 'bug', severity: null })
    const set = await run(() =>
      caller().support.tickets.setSeverity({
        projectId: 'proj_1',
        id: 'tkt_1',
        severity: 'blocker',
      }),
    )
    expect(set.severity).toBe('blocker')

    const cleared = await run(() =>
      caller().support.tickets.setSeverity({ projectId: 'proj_1', id: 'tkt_1', severity: null }),
    )
    expect(cleared.severity).toBeNull()
  })

  it('setSeverity REJECTS a conversation with BAD_REQUEST and writes nothing', async () => {
    seedTicket({ type: 'conversation', severity: null })
    const err = await run(() =>
      caller()
        .support.tickets.setSeverity({ projectId: 'proj_1', id: 'tkt_1', severity: 'major' })
        .catch((e: unknown) => e),
    )
    expect((err as TRPCError).code).toBe('BAD_REQUEST')
    expect(tickets[0].severity).toBeNull()
  })

  it('neither mutation enqueues a webhook delivery (ticket.updated stays unemitted)', async () => {
    seedTicket({ type: 'bug' })
    webhooks.push({
      id: 'wh_1',
      projectId: 'proj_1',
      url: 'https://example.com/hook',
      secret: 'enc',
      events: ['ticket.updated', 'ticket.replied', 'ticket.resolved'],
      active: true,
      deletedAt: null,
    })
    await run(() =>
      caller().support.tickets.setPriority({ projectId: 'proj_1', id: 'tkt_1', priority: 'high' }),
    )
    await run(() =>
      caller().support.tickets.setSeverity({ projectId: 'proj_1', id: 'tkt_1', severity: 'minor' }),
    )
    expect(deliveries).toHaveLength(0)
  })

  it('get returns a validated bugReport alongside the untouched context passthrough', async () => {
    const bugReport = {
      capturedAt: '2026-07-25T00:00:00.000Z',
      environment: { url: 'https://example.com/checkout', browser: 'Chrome' },
      consoleErrors: [{ level: 'error', message: 'boom', timestamp: '2026-07-25T00:00:00.000Z' }],
    }
    seedTicket({ type: 'bug', severity: 'blocker', bugReport })
    const res = await run(() => caller().support.tickets.get({ projectId: 'proj_1', id: 'tkt_1' }))
    expect(res.bugReport).toEqual(bugReport)
    expect(res.ticket).toMatchObject({ type: 'bug', severity: 'blocker' })
    // The context bundle is untouched.
    expect(res.context).toMatchObject({ identity: { email: 'a@b.co' } })
  })

  it('get returns bugReport:null for a conversation and for a pre-phase row', async () => {
    seedTicket({ id: 'convo' })
    // A row written before: no `type`, no `severity`, no `bugReport`.
    tickets.push({
      id: 'legacy',
      formId: 'form_1',
      number: 2,
      status: 'open',
      context: null,
      unreadForAgent: 0,
      createdAt: new Date('2026-01-05T00:00:00.000Z'),
    })

    const convo = await run(() =>
      caller().support.tickets.get({ projectId: 'proj_1', id: 'convo' }),
    )
    expect(convo.bugReport).toBeNull()

    const legacy = await run(() =>
      caller().support.tickets.get({ projectId: 'proj_1', id: 'legacy' }),
    )
    expect(legacy.bugReport).toBeNull()
  })

  it('parseBugReport returns null for a malformed blob instead of throwing', async () => {
    const { parseBugReport } = await import('./support.router.js')

    // Malformed payloads on a genuine bug — never a 500 in the inbox.
    expect(parseBugReport({ type: 'bug', bugReport: { capturedAt: 42 } })).toBeNull()
    expect(parseBugReport({ type: 'bug', bugReport: { rogueKey: true } })).toBeNull()
    expect(parseBugReport({ type: 'bug', bugReport: 'not-an-object' })).toBeNull()
    expect(parseBugReport({ type: 'bug', bugReport: [] })).toBeNull()
    expect(parseBugReport({ type: 'bug', severity: 'critical', bugReport: null })).toBeNull()

    // Non-bug / pre-phase rows.
    expect(parseBugReport({ type: 'conversation', severity: null, bugReport: null })).toBeNull()
    expect(parseBugReport({})).toBeNull()

    // The happy path still comes back intact.
    const good = { capturedAt: '2026-07-25T00:00:00.000Z' }
    expect(parseBugReport({ type: 'bug', severity: 'minor', bugReport: good })).toEqual(good)
  })

  it('results.volumeByType aggregates from Postgres, not ClickHouse', async () => {
    seedTicket({ id: 'c1', type: 'conversation' })
    seedTicket({ id: 'c2', type: 'conversation' })
    seedTicket({ id: 'b1', type: 'bug' })
    // Different form, and outside the range -> both excluded.
    seedTicket({ id: 'other', type: 'bug', formId: 'form_2' })
    seedTicket({ id: 'old', type: 'bug', createdAt: new Date('2025-01-01T00:00:00.000Z') })

    const res = await run(() =>
      caller().support.results.volumeByType({
        projectId: 'proj_1',
        formId: 'form_1',
        range: RANGE,
      }),
    )
    expect(res).toEqual([
      { value: 'conversation', count: 2 },
      { value: 'bug', count: 1 },
    ])
  })
})

describe('supportAppearanceSchema — expanded appearance fields', () => {
  it('round-trips every new appearance field', async () => {
    const { supportAppearanceSchema } = await import('./support.schema.js')
    const full = {
      layout: 'launcher' as const,
      position: 'bottom_right' as const,
      launcherIcon: 'chat' as const,
      launcherSize: 64,
      cornerRadius: 8,
      panelWidth: 420,
      headerStyle: 'plain' as const,
      hideBranding: true,
      fontFamily: 'Comic Sans MS, cursive',
    }
    expect(supportAppearanceSchema.parse(full)).toEqual(full)
  })

  it('keeps every new field optional (the minimal appearance still parses)', async () => {
    const { supportAppearanceSchema } = await import('./support.schema.js')
    const minimal = { layout: 'launcher' as const, position: 'bottom_right' as const }
    expect(supportAppearanceSchema.parse(minimal)).toEqual(minimal)
  })

  it('enforces the enum + numeric bounds and rejects raw-SVG launcher icons', async () => {
    const { supportAppearanceSchema } = await import('./support.schema.js')
    const base = { layout: 'launcher' as const, position: 'bottom_right' as const }
    // launcherIcon is a closed enum — no raw SVG/HTML.
    expect(() =>
      supportAppearanceSchema.parse({ ...base, launcherIcon: '<svg onload=alert(1)>' }),
    ).toThrow()
    // Numeric bounds: launcherSize 40–72, cornerRadius 0–24, panelWidth 300–480.
    expect(() => supportAppearanceSchema.parse({ ...base, launcherSize: 39 })).toThrow()
    expect(() => supportAppearanceSchema.parse({ ...base, launcherSize: 73 })).toThrow()
    expect(() => supportAppearanceSchema.parse({ ...base, cornerRadius: 25 })).toThrow()
    expect(() => supportAppearanceSchema.parse({ ...base, panelWidth: 299 })).toThrow()
    expect(() => supportAppearanceSchema.parse({ ...base, headerStyle: 'fancy' })).toThrow()
    // `.strict()` is preserved — an unknown key is rejected.
    expect(() => supportAppearanceSchema.parse({ ...base, bogus: true })).toThrow()
  })

  it('survives a full create/read cycle through the router with the expanded appearance', async () => {
    const appearance = {
      layout: 'launcher' as const,
      position: 'bottom_right' as const,
      launcherIcon: 'help' as const,
      launcherSize: 60,
      cornerRadius: 12,
      panelWidth: 360,
      headerStyle: 'plain' as const,
      hideBranding: true,
      fontFamily: 'Inter, sans-serif',
    }
    const created = await run(() =>
      caller().support.create({
        projectId: 'proj_1',
        name: 'Themed',
        definition: { ...DEFINITION, appearance },
      }),
    )
    expect((created.definition as { appearance: unknown }).appearance).toEqual(appearance)
  })
})

describe('support.webhooks', () => {
  it('returns the plaintext secret exactly once and never again', async () => {
    const created = await run(() =>
      caller().support.webhooks.create({
        projectId: 'proj_1',
        name: 'Example',
        url: 'https://example.com/hook',
        events: ['ticket.created'],
      }),
    )
    expect(created.secret).toMatch(/^[0-9a-f]{64}$/)
    // Stored encrypted, not in plaintext.
    expect(webhooks[0].secret).not.toBe(created.secret)
    expect(String(webhooks[0].secret)).toContain('ciphertext')

    const listed = await run(() => caller().support.webhooks.list({ projectId: 'proj_1' }))
    expect(listed).toHaveLength(1)
    expect('secret' in listed[0]).toBe(false)
  })

  it('updates and soft-deletes without exposing the secret', async () => {
    const created = await run(() =>
      caller().support.webhooks.create({
        projectId: 'proj_1',
        name: 'Example',
        url: 'https://example.com/hook',
        events: ['ticket.created'],
      }),
    )
    const updated = await run(() =>
      caller().support.webhooks.update({
        projectId: 'proj_1',
        id: created.id,
        patch: { active: false, events: ['ticket.replied'] },
      }),
    )
    expect(updated.active).toBe(false)
    expect(updated.events).toEqual(['ticket.replied'])
    expect('secret' in updated).toBe(false)

    await run(() => caller().support.webhooks.delete({ projectId: 'proj_1', id: created.id }))
    expect(webhooks[0].deletedAt).toBeInstanceOf(Date)
    expect(await run(() => caller().support.webhooks.list({ projectId: 'proj_1' }))).toHaveLength(0)
  })

  it('stores the last four plaintext chars as the mask hint, and nothing more', async () => {
    const created = await run(() =>
      caller().support.webhooks.create({
        projectId: 'proj_1',
        name: 'Example',
        url: 'https://example.com/hook',
        events: ['ticket.created'],
      }),
    )
    expect(webhooks[0].secretHint).toBe(created.secret.slice(-4))
    expect(String(webhooks[0].secretHint)).toHaveLength(4)
  })

  it('persists the name on create and on update', async () => {
    const created = await run(() =>
      caller().support.webhooks.create({
        projectId: 'proj_1',
        name: 'Zendesk bridge',
        url: 'https://example.com/hook',
        events: ['ticket.created'],
      }),
    )
    expect(created.name).toBe('Zendesk bridge')
    const updated = await run(() =>
      caller().support.webhooks.update({
        projectId: 'proj_1',
        id: created.id,
        patch: { name: 'Ops pager' },
      }),
    )
    expect(updated.name).toBe('Ops pager')
    expect(webhooks[0].name).toBe('Ops pager')
  })

  it('rejects a non-HTTPS endpoint at the input boundary, before any request', async () => {
    await expect(
      run(() =>
        caller().support.webhooks.create({
          projectId: 'proj_1',
          name: 'Example',
          url: 'http://example.com/hook',
          events: ['ticket.created'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(webhooks).toHaveLength(0)
  })

  it('requires a name of 1..80 characters', async () => {
    for (const name of ['', 'x'.repeat(81)]) {
      await expect(
        run(() =>
          caller().support.webhooks.create({
            projectId: 'proj_1',
            name,
            url: 'https://example.com/hook',
            events: ['ticket.created'],
          }),
        ),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    }
    expect(webhooks).toHaveLength(0)
  })
})

describe('support.webhooks.rotateSecret', () => {
  async function seedWebhook() {
    return run(() =>
      caller().support.webhooks.create({
        projectId: 'proj_1',
        name: 'Example',
        url: 'https://example.com/hook',
        events: ['ticket.created'],
      }),
    )
  }

  it('returns the new plaintext once, opens a 24h grace window, and never leaks either secret', async () => {
    const created = await seedWebhook()
    const before = webhooks[0].secret

    const rotated = await run(() =>
      caller().support.webhooks.rotateSecret({ projectId: 'proj_1', id: created.id }),
    )

    expect(rotated.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(rotated.secret).not.toBe(created.secret)
    // The outgoing ciphertext moves to `previousSecret` verbatim — the worker
    // decrypts it to keep signing `v1` for the whole window.
    expect(webhooks[0].previousSecret).toBe(before)
    expect(webhooks[0].secret).not.toBe(before)
    expect(webhooks[0].secretHint).toBe(rotated.secret.slice(-4))
    const rotatedAt = webhooks[0].secretRotatedAt as Date
    const expiresAt = webhooks[0].previousSecretExpiresAt as Date
    expect(expiresAt.getTime() - rotatedAt.getTime()).toBe(24 * 60 * 60 * 1000)

    // Neither the rotate response nor `list` carries ciphertext of either secret.
    expect('secret' in rotated).toBe(true) // the plaintext, exactly once
    expect('previousSecret' in rotated).toBe(false)
    const [listed] = await run(() => caller().support.webhooks.list({ projectId: 'proj_1' }))
    expect('secret' in listed).toBe(false)
    expect('previousSecret' in listed).toBe(false)
    expect(JSON.stringify(listed)).not.toContain(rotated.secret)
  })

  it('refuses a second rotation while the first is still in grace', async () => {
    const created = await seedWebhook()
    await run(() => caller().support.webhooks.rotateSecret({ projectId: 'proj_1', id: created.id }))
    const previousAfterFirst = webhooks[0].previousSecret

    await expect(
      run(() => caller().support.webhooks.rotateSecret({ projectId: 'proj_1', id: created.id })),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    // The refusal is what protects the secret the customer may still be running.
    expect(webhooks[0].previousSecret).toBe(previousAfterFirst)
  })

  it('allows rotating again once the grace window has expired', async () => {
    const created = await seedWebhook()
    await run(() => caller().support.webhooks.rotateSecret({ projectId: 'proj_1', id: created.id }))
    webhooks[0].previousSecretExpiresAt = new Date(Date.now() - 1_000)

    const second = await run(() =>
      caller().support.webhooks.rotateSecret({ projectId: 'proj_1', id: created.id }),
    )
    expect(second.secret).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('support.webhooks.sendTest', () => {
  let lastRequest: { url: string; init: RequestInit } | null = null

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch(response: { status: number; body?: string; delayMs?: number } | Error) {
    lastRequest = null
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      lastRequest = { url, init }
      if (response instanceof Error) throw response
      return new Response(response.body ?? '', {
        status: response.status,
        headers: { 'content-type': 'text/plain' },
      })
    })
  }

  async function seedWebhook() {
    return run(() =>
      caller().support.webhooks.create({
        projectId: 'proj_1',
        name: 'Example',
        url: 'https://example.com/hook',
        events: ['ticket.created'],
      }),
    )
  }

  it('POSTs a signed ping for an UNSAVED url and writes no rows', async () => {
    stubFetch({ status: 200, body: 'ok' })

    const res = await run(() =>
      caller().support.webhooks.sendTest({
        projectId: 'proj_1',
        url: 'https://example.com/new-hook',
        events: ['ticket.created'],
      }),
    )

    expect(res).toMatchObject({ status: 'delivered', code: 200, body: 'ok', error: null })
    expect(typeof res.latencyMs).toBe('number')
    // Pre-save there is no webhook row to hang a delivery off.
    expect(res.deliveryId).toBeNull()
    expect(deliveries).toHaveLength(0)
    expect(webhookAttempts).toHaveLength(0)

    expect(lastRequest?.url).toBe('https://example.com/new-hook')
    const headers = lastRequest?.init.headers as Record<string, string>
    expect(headers['X-Clickroom-Event']).toBe('ping')
    expect(headers['X-Clickroom-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
    expect(JSON.parse(String(lastRequest?.init.body))).toMatchObject({
      type: 'ping',
      projectId: 'proj_1',
      webhookId: null,
    })
  })

  it('records a test delivery and its attempt for a saved webhook', async () => {
    const created = await seedWebhook()
    stubFetch({ status: 200, body: 'pong' })

    const res = await run(() =>
      caller().support.webhooks.sendTest({ projectId: 'proj_1', id: created.id }),
    )

    expect(res.deliveryId).toBeTruthy()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      id: res.deliveryId,
      webhookId: created.id,
      ticketId: null,
      event: 'ping',
      // Terminal on write: a test must never be claimed and retried by the sweep,
      // whose predicate is `status='pending'`.
      status: 'delivered',
      isTest: true,
      attempts: 1,
      lastStatusCode: 200,
    })
    expect(webhookAttempts).toHaveLength(1)
    expect(webhookAttempts[0]).toMatchObject({
      deliveryId: res.deliveryId,
      webhookId: created.id,
      attempt: 1,
      responseCode: 200,
      outcome: 'delivered',
      responseBody: 'pong',
      bodyTruncated: false,
    })
    // The signed request is stored verbatim — it is what a customer debugging a
    // verification failure needs to see.
    const requestHeaders = webhookAttempts[0].requestHeaders as Record<string, string>
    expect(requestHeaders['X-Clickroom-Delivery']).toBe(res.deliveryId)
    expect(requestHeaders['X-Clickroom-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)

    // The header carries the signature the delivery id was signed under; the
    // delivery id itself is the customer's idempotency key.
    const sentHeaders = lastRequest?.init.headers as Record<string, string>
    expect(sentHeaders['X-Clickroom-Delivery']).toBe(res.deliveryId)
  })

  it('signs v1=previous, v2=current while a rotation is in grace', async () => {
    const created = await seedWebhook()
    await run(() => caller().support.webhooks.rotateSecret({ projectId: 'proj_1', id: created.id }))
    stubFetch({ status: 204 })

    await run(() => caller().support.webhooks.sendTest({ projectId: 'proj_1', id: created.id }))

    const headers = lastRequest?.init.headers as Record<string, string>
    expect(headers['X-Clickroom-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64},v2=[0-9a-f]{64}$/)
  })

  it('records a non-2xx as a failed test with the response body intact', async () => {
    const created = await seedWebhook()
    stubFetch({ status: 401, body: 'bad token' })

    const res = await run(() =>
      caller().support.webhooks.sendTest({ projectId: 'proj_1', id: created.id }),
    )

    expect(res).toMatchObject({ status: 'failed', code: 401, body: 'bad token' })
    expect(deliveries[0]).toMatchObject({ status: 'failed', lastStatusCode: 401, isTest: true })
    expect(webhookAttempts[0]).toMatchObject({ outcome: 'fatal_http', responseCode: 401 })
  })

  it('records a network failure with no status code', async () => {
    const created = await seedWebhook()
    stubFetch(new Error('getaddrinfo ENOTFOUND'))

    const res = await run(() =>
      caller().support.webhooks.sendTest({ projectId: 'proj_1', id: created.id }),
    )

    expect(res.status).toBe('failed')
    expect(res.code).toBeNull()
    expect(webhookAttempts[0]).toMatchObject({ outcome: 'network', responseCode: null })
  })

  it('refuses an endpoint that resolves to a private address, without sending', async () => {
    stubFetch({ status: 200 })
    resolvedAddresses = ['127.0.0.1']

    await expect(
      run(() =>
        caller().support.webhooks.sendTest({
          projectId: 'proj_1',
          url: 'https://internal.example.com/hook',
          events: ['ticket.created'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(lastRequest).toBeNull()
  })
})

describe('support.webhooks.affectedForms', () => {
  function seedForm(id: string, name: string, destinations: Array<{ webhookId: string }>) {
    forms.push({
      id,
      projectId: 'proj_1',
      name,
      status: 'live',
      definition: { ...DEFINITION, routing: { destinations, autoReply: false } },
      deletedAt: null,
      createdAt: new Date(`2026-01-0${forms.length + 1}T00:00:00.000Z`),
    })
  }

  it('names only the forms whose routing points at this webhook', async () => {
    webhooks.push({
      id: 'wh_1',
      projectId: 'proj_1',
      url: 'https://example.com/hook',
      secret: 'enc',
      events: ['ticket.created'],
      active: true,
      deletedAt: null,
    })
    seedForm('form_1', 'Contact us', [{ webhookId: 'wh_1' }])
    seedForm('form_2', 'Bug report', [{ webhookId: 'wh_other' }])
    seedForm('form_3', 'Feedback', [])
    seedForm('form_4', 'Sales', [{ webhookId: 'wh_other' }, { webhookId: 'wh_1' }])

    const res = await run(() =>
      caller().support.webhooks.affectedForms({ projectId: 'proj_1', id: 'wh_1' }),
    )

    expect(res.map((f) => f.id)).toEqual(['form_1', 'form_4'])
  })

  it('404s for a webhook outside the project or already deleted', async () => {
    webhooks.push({
      id: 'wh_deleted',
      projectId: 'proj_1',
      url: 'https://example.com/hook',
      secret: 'enc',
      events: [],
      active: true,
      deletedAt: new Date(),
    })
    await expect(
      run(() => caller().support.webhooks.affectedForms({ projectId: 'proj_1', id: 'wh_deleted' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('support.webhooks.deliveries', () => {
  /** Seed a delivery row directly — the dispatcher, not tRPC, writes these. */
  function seedDelivery(overrides: Row = {}) {
    const row: Row = {
      id: 'dlv_1',
      webhookId: 'wh_1',
      ticketId: 'tkt_1',
      event: 'ticket.created',
      payload: { subject: 'Help', distinctId: 'anon_1' },
      status: 'pending',
      attempts: 0,
      lastError: null,
      lastStatusCode: null,
      nextAttemptAt: new Date('2026-01-05T00:00:00.000Z'),
      createdAt: new Date('2026-01-05T00:00:00.000Z'),
      updatedAt: new Date('2026-01-05T00:00:00.000Z'),
      ...overrides,
    }
    deliveries.push(row)
    return row
  }

  function seedWebhook(overrides: Row = {}) {
    const row: Row = {
      id: 'wh_1',
      projectId: 'proj_1',
      url: 'https://example.com/hook',
      secret: 'ciphertext:abc',
      events: ['ticket.created'],
      active: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
      ...overrides,
    }
    webhooks.push(row)
    return row
  }

  it('returns the webhook’s history newest-first, with the failure detail and no secret', async () => {
    seedWebhook()
    seedWebhook({ id: 'wh_2' })
    seedDelivery({ id: 'd1', createdAt: new Date('2026-01-05T00:00:00.000Z') })
    seedDelivery({
      id: 'd2',
      createdAt: new Date('2026-01-06T00:00:00.000Z'),
      status: 'failed',
      attempts: 3,
      lastError: 'connect ETIMEDOUT',
      lastStatusCode: 504,
    })
    seedDelivery({ id: 'd3', webhookId: 'wh_2' })

    const res = await run(() =>
      caller().support.webhooks.deliveries({ projectId: 'proj_1', webhookId: 'wh_1' }),
    )
    expect(res.items.map((d) => d.id)).toEqual(['d2', 'd1'])
    expect(res.nextCursor).toBeNull()
    expect(res.items[0]).toMatchObject({
      status: 'failed',
      attempts: 3,
      lastError: 'connect ETIMEDOUT',
      lastStatusCode: 504,
    })
    // The payload is the point of the log — returned whole.
    expect(res.items[1].payload).toEqual({ subject: 'Help', distinctId: 'anon_1' })
    // The joined webhook (and its encrypted secret) never rides along.
    expect('webhook' in res.items[0]).toBe(false)
    expect('secret' in res.items[0]).toBe(false)
  })

  it('filters by status', async () => {
    seedWebhook()
    seedDelivery({ id: 'd1', status: 'delivered' })
    seedDelivery({ id: 'd2', status: 'failed' })
    seedDelivery({ id: 'd3', status: 'pending' })

    const res = await run(() =>
      caller().support.webhooks.deliveries({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        status: 'failed',
      }),
    )
    expect(res.items.map((d) => d.id)).toEqual(['d2'])
  })

  it('paginates with an id cursor', async () => {
    seedWebhook()
    for (let i = 1; i <= 3; i++) {
      seedDelivery({ id: `d${i}`, createdAt: new Date(`2026-01-0${i}T00:00:00.000Z`) })
    }

    const first = await run(() =>
      caller().support.webhooks.deliveries({ projectId: 'proj_1', webhookId: 'wh_1', limit: 2 }),
    )
    expect(first.items.map((d) => d.id)).toEqual(['d3', 'd2'])
    expect(first.nextCursor).toBe('d2')

    const second = await run(() =>
      caller().support.webhooks.deliveries({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        limit: 2,
        cursor: first.nextCursor,
      }),
    )
    expect(second.items.map((d) => d.id)).toEqual(['d1'])
    expect(second.nextCursor).toBeNull()
  })

  it('404s for a webhook outside the project (RLS hides the row) or soft-deleted', async () => {
    seedWebhook({ id: 'wh_deleted', deletedAt: new Date() })
    seedDelivery({ id: 'd1', webhookId: 'wh_deleted' })

    for (const webhookId of ['wh_other_project', 'wh_deleted']) {
      const err = await run(() =>
        caller()
          .support.webhooks.deliveries({ projectId: 'proj_1', webhookId })
          .catch((e: unknown) => e),
      )
      expect((err as TRPCError).code).toBe('NOT_FOUND')
    }
  })
})

// ── ──────────────────────────────────────────────────────────────────

/** Seed a webhook row directly (no create() round-trip, no secret plumbing). */
function seedRawWebhook(overrides: Row = {}) {
  const row: Row = {
    id: 'wh_1',
    projectId: 'proj_1',
    name: 'Example',
    url: 'https://example.com/hook',
    secret: 'ciphertext:abc',
    events: ['ticket.created'],
    active: true,
    consecutiveFailures: 0,
    autoDisabledAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  }
  webhooks.push(row)
  return row
}

/** Seed a delivery row directly — the dispatcher, not tRPC, writes these. */
function seedRawDelivery(overrides: Row = {}) {
  const row: Row = {
    id: 'dlv_1',
    webhookId: 'wh_1',
    ticketId: null,
    event: 'ticket.created',
    payload: {},
    status: 'pending',
    attempts: 0,
    lastError: null,
    lastStatusCode: null,
    isTest: false,
    nextAttemptAt: new Date('2026-01-05T00:00:00.000Z'),
    createdAt: new Date('2026-01-05T00:00:00.000Z'),
    ...overrides,
  }
  deliveries.push(row)
  return row
}

describe('supportWebhookHealth (pure mapping)', () => {
  it('maps each of the four boundaries the way the spec states them', async () => {
    const { supportWebhookHealth } = await import('./support.router.js')

    // Nothing in the window at all — never delivered, not a failure.
    expect(supportWebhookHealth({ considered: 0, failures: 0, p95LatencyMs: null })).toBe('idle')
    expect(supportWebhookHealth({ considered: 0, failures: 0, p95LatencyMs: 9_000 })).toBe('idle')

    // <= 1 failure is healthy, and wins BEFORE the latency clause — a fast
    // endpoint with one bad delivery is not "degraded".
    expect(supportWebhookHealth({ considered: 20, failures: 0, p95LatencyMs: 120 })).toBe('healthy')
    expect(supportWebhookHealth({ considered: 20, failures: 1, p95LatencyMs: 120 })).toBe('healthy')
    expect(supportWebhookHealth({ considered: 20, failures: 1, p95LatencyMs: 9_999 })).toBe(
      'healthy',
    )

    // 2..5 failures is degraded; 5 is the last one that is.
    expect(supportWebhookHealth({ considered: 20, failures: 2, p95LatencyMs: 120 })).toBe(
      'degraded',
    )
    expect(supportWebhookHealth({ considered: 20, failures: 5, p95LatencyMs: 120 })).toBe(
      'degraded',
    )

    // 3000ms is NOT over the line; 3001ms is — and it rescues an otherwise
    // failing rollup into degraded, exactly as the spec's `||` orders it.
    expect(supportWebhookHealth({ considered: 20, failures: 6, p95LatencyMs: 3_000 })).toBe(
      'failing',
    )
    expect(supportWebhookHealth({ considered: 20, failures: 6, p95LatencyMs: 3_001 })).toBe(
      'degraded',
    )

    // 6+ failures with no latency signal at all is failing.
    expect(supportWebhookHealth({ considered: 20, failures: 6, p95LatencyMs: null })).toBe(
      'failing',
    )
    expect(supportWebhookHealth({ considered: 20, failures: 20, p95LatencyMs: 10 })).toBe('failing')
  })
})

describe('support.webhooks.deliveries filters', () => {
  it("maps 'retrying' to pending AND attempts>0, and never writes that status", async () => {
    seedRawWebhook()
    seedRawDelivery({ id: 'queued', status: 'pending', attempts: 0 })
    seedRawDelivery({ id: 'retrying', status: 'pending', attempts: 2 })
    seedRawDelivery({ id: 'done', status: 'delivered', attempts: 1 })
    seedRawDelivery({ id: 'dead', status: 'failed', attempts: 5 })

    const retrying = await run(() =>
      caller().support.webhooks.deliveries({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        status: 'retrying',
      }),
    )
    // A pending row with NO attempt behind it is queued, not retrying.
    expect(retrying.items.map((d) => d.id)).toEqual(['retrying'])
    expect(retrying.items[0]).toMatchObject({ status: 'pending', attempts: 2 })

    // 'all' is the unfiltered view.
    const all = await run(() =>
      caller().support.webhooks.deliveries({ projectId: 'proj_1', webhookId: 'wh_1' }),
    )
    expect(all.items).toHaveLength(4)

    // Constraint 1: `'retrying'` is a VIEW. The worker's claim predicate is
    // `status='pending'`, so a third stored value would silently stop every
    // retry — nothing anywhere may write it.
    expect(deliveries.every((d) => d.status !== 'retrying')).toBe(true)
    expect(new Set(deliveries.map((d) => d.status))).toEqual(
      new Set(['pending', 'delivered', 'failed']),
    )
  })

  it('runs a retry through the router and STILL never stores a retrying status', async () => {
    seedRawWebhook()
    seedRawDelivery({ id: 'dead', status: 'failed', attempts: 5 })

    await run(() =>
      caller().support.webhooks.retry({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        deliveryId: 'dead',
      }),
    )
    // The requeued row is `pending` with the backoff rewound, which is what the
    // sheet then RENDERS as "Retrying" — the derived view, not a stored value.
    expect(deliveries[0]).toMatchObject({ status: 'pending', attempts: 0 })
    expect(deliveries.every((d) => d.status !== 'retrying')).toBe(true)
  })

  it('bounds the window on createdAt and reports the filtered total', async () => {
    seedRawWebhook()
    seedRawDelivery({ id: 'old', createdAt: new Date('2026-01-01T00:00:00.000Z') })
    seedRawDelivery({ id: 'mid', createdAt: new Date('2026-01-10T00:00:00.000Z') })
    seedRawDelivery({ id: 'new', createdAt: new Date('2026-01-20T00:00:00.000Z') })

    const res = await run(() =>
      caller().support.webhooks.deliveries({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        from: '2026-01-05T00:00:00.000Z',
        to: '2026-01-15T00:00:00.000Z',
      }),
    )
    expect(res.items.map((d) => d.id)).toEqual(['mid'])
    expect(res.total).toBe(1)
  })

  it('reports a total larger than the page, for "Showing 2 of 5"', async () => {
    seedRawWebhook()
    for (let i = 1; i <= 5; i++) {
      seedRawDelivery({ id: `d${i}`, createdAt: new Date(`2026-01-0${i}T00:00:00.000Z`) })
    }
    const res = await run(() =>
      caller().support.webhooks.deliveries({ projectId: 'proj_1', webhookId: 'wh_1', limit: 2 }),
    )
    expect(res.items).toHaveLength(2)
    expect(res.total).toBe(5)
    expect(res.nextCursor).toBe('d4')
  })

  it('joins the ticket number/subject and the attempts, newest attempt first', async () => {
    seedRawWebhook()
    seedTicket({ id: 'tkt_1', number: 42, subject: 'Checkout is broken' })
    seedRawDelivery({ id: 'd1', ticketId: 'tkt_1', status: 'failed', attempts: 2 })
    webhookAttempts.push(
      { id: 'a1', deliveryId: 'd1', webhookId: 'wh_1', attempt: 1, latencyMs: 90 },
      { id: 'a2', deliveryId: 'd1', webhookId: 'wh_1', attempt: 2, latencyMs: 4_100 },
    )

    const res = await run(() =>
      caller().support.webhooks.deliveries({ projectId: 'proj_1', webhookId: 'wh_1' }),
    )
    const [row] = res.items as unknown as Array<{
      ticket: { number: number; subject: string }
      attempts_: Array<{ attempt: number }>
    }>
    expect(row.ticket).toEqual({ number: 42, subject: 'Checkout is broken' })
    expect(row.attempts_.map((a) => a.attempt)).toEqual([2, 1])
    // The webhook relation stays un-joined: it carries the encrypted secret.
    expect('webhook' in res.items[0]).toBe(false)
  })
})

describe('support.webhooks.retryAllFailed', () => {
  it('caps one invocation at 500 and reports the cap', async () => {
    seedRawWebhook()
    for (let i = 0; i < 620; i++) {
      seedRawDelivery({
        id: `d${String(i).padStart(4, '0')}`,
        status: 'failed',
        attempts: 5,
        createdAt: new Date(2026, 0, 1, 0, 0, i),
      })
    }

    const first = await run(() =>
      caller().support.webhooks.retryAllFailed({ projectId: 'proj_1', webhookId: 'wh_1' }),
    )
    expect(first).toMatchObject({ requeued: 500, cap: 500, capped: true })
    expect(deliveries.filter((d) => d.status === 'pending')).toHaveLength(500)
    expect(deliveries.filter((d) => d.status === 'failed')).toHaveLength(120)
    // Oldest-first, so a second run drains the rest rather than re-picking the
    // same newest 500 forever.
    expect(deliveries.find((d) => d.id === 'd0000')?.status).toBe('pending')
    expect(deliveries.find((d) => d.id === 'd0619')?.status).toBe('failed')

    const second = await run(() =>
      caller().support.webhooks.retryAllFailed({ projectId: 'proj_1', webhookId: 'wh_1' }),
    )
    expect(second).toMatchObject({ requeued: 120, capped: false })
    expect(deliveries.every((d) => d.status === 'pending')).toBe(true)
    // Every requeued row rewinds the backoff schedule; none is left mid-tail.
    expect(deliveries.every((d) => d.attempts === 0)).toBe(true)
  })

  it('only touches failed rows in this webhook and inside the window', async () => {
    seedRawWebhook()
    seedRawWebhook({ id: 'wh_2' })
    seedRawDelivery({ id: 'mine', status: 'failed', createdAt: new Date('2026-01-10T00:00:00Z') })
    seedRawDelivery({ id: 'old', status: 'failed', createdAt: new Date('2026-01-01T00:00:00Z') })
    seedRawDelivery({ id: 'queued', status: 'pending', attempts: 0 })
    seedRawDelivery({ id: 'theirs', webhookId: 'wh_2', status: 'failed' })

    const res = await run(() =>
      caller().support.webhooks.retryAllFailed({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        from: '2026-01-05T00:00:00.000Z',
      }),
    )
    expect(res.requeued).toBe(1)
    expect(deliveries.find((d) => d.id === 'mine')?.status).toBe('pending')
    expect(deliveries.find((d) => d.id === 'old')?.status).toBe('failed')
    expect(deliveries.find((d) => d.id === 'theirs')?.status).toBe('failed')
  })

  it('404s for a webhook outside the project', async () => {
    await expect(
      run(() =>
        caller().support.webhooks.retryAllFailed({ projectId: 'proj_1', webhookId: 'wh_nope' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

// ── The `7a` delivery history page ──────────────────────────────
// The sheet became a routed page, so every filter lives in the URL and the
// toolbar renders segment counts, a volume chart and Export CSV.

/** A delivery plus its single attempt row, which is what a body search reads. */
function seedDeliveryWithAttempt(overrides: Row, attempt: Row = {}) {
  const row = seedRawDelivery(overrides)
  webhookAttempts.push({
    id: `${row.id}-a1`,
    deliveryId: row.id,
    webhookId: row.webhookId,
    attempt: 1,
    latencyMs: 120,
    responseCode: row.lastStatusCode ?? null,
    outcome: 'delivered',
    responseBody: null,
    bodiesPurgedAt: null,
    ...attempt,
  })
  return row
}

describe('support.webhooks.deliveries — event / code / search filters (7a)', () => {
  it('filters by event, including the synthetic ping sendTest writes', async () => {
    seedRawWebhook()
    seedRawDelivery({ id: 'created', event: 'ticket.created' })
    seedRawDelivery({ id: 'replied', event: 'ticket.replied' })
    seedRawDelivery({ id: 'ping', event: 'ping', isTest: true })

    const created = await run(() =>
      caller().support.webhooks.deliveries({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        event: 'ticket.created',
      }),
    )
    expect(created.items.map((d) => d.id)).toEqual(['created'])

    const ping = await run(() =>
      caller().support.webhooks.deliveries({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        event: 'ping',
      }),
    )
    expect(ping.items.map((d) => d.id)).toEqual(['ping'])
  })

  it('bounds the response code range on lastStatusCode, and never matches a no-response row', async () => {
    seedRawWebhook()
    seedRawDelivery({ id: 'ok', status: 'delivered', lastStatusCode: 200 })
    seedRawDelivery({ id: 'unauthorized', status: 'failed', lastStatusCode: 401 })
    seedRawDelivery({ id: 'boom', status: 'failed', lastStatusCode: 503 })
    // DNS/connect/timeout: no status at all. "500–599" must not sweep it up.
    seedRawDelivery({ id: 'silent', status: 'failed', lastStatusCode: null })

    const serverErrors = await run(() =>
      caller().support.webhooks.deliveries({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        responseCodeMin: 500,
        responseCodeMax: 599,
      }),
    )
    expect(serverErrors.items.map((d) => d.id)).toEqual(['boom'])

    const allErrors = await run(() =>
      caller().support.webhooks.deliveries({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        responseCodeMin: 400,
      }),
    )
    expect(new Set(allErrors.items.map((d) => d.id))).toEqual(new Set(['unauthorized', 'boom']))
  })

  it('rejects an inverted response code range instead of returning nothing', async () => {
    seedRawWebhook()
    await expect(
      run(() =>
        caller().support.webhooks.deliveries({
          projectId: 'proj_1',
          webhookId: 'wh_1',
          responseCodeMin: 500,
          responseCodeMax: 400,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('searches ticket id exactly, ticket number with or without #, and response body by substring', async () => {
    seedRawWebhook()
    seedTicket({ id: 'tkt_a', number: 1042, subject: 'Checkout' })
    seedDeliveryWithAttempt({ id: 'byTicket', ticketId: 'tkt_a' }, { responseBody: 'ok' })
    seedDeliveryWithAttempt(
      { id: 'byBody', ticketId: null },
      { responseBody: '{"error":"Signature MISMATCH"}' },
    )
    seedDeliveryWithAttempt({ id: 'unrelated', ticketId: null }, { responseBody: 'fine' })

    const byId = await run(() =>
      caller().support.webhooks.deliveries({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        search: 'tkt_a',
      }),
    )
    expect(byId.items.map((d) => d.id)).toEqual(['byTicket'])

    // An id PREFIX is not a match — ids are exact, by design.
    const byPrefix = await run(() =>
      caller().support.webhooks.deliveries({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        search: 'tkt',
      }),
    )
    expect(byPrefix.items).toHaveLength(0)

    for (const term of ['1042', '#1042']) {
      const byNumber = await run(() =>
        caller().support.webhooks.deliveries({
          projectId: 'proj_1',
          webhookId: 'wh_1',
          search: term,
        }),
      )
      expect(byNumber.items.map((d) => d.id)).toEqual(['byTicket'])
    }

    // Response body is a case-insensitive SUBSTRING — pasting the error your
    // server returned is how anyone actually finds the delivery they want.
    const byBody = await run(() =>
      caller().support.webhooks.deliveries({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        search: 'signature mismatch',
      }),
    )
    expect(byBody.items.map((d) => d.id)).toEqual(['byBody'])
  })

  it('reports how many deliveries in the view have purged bodies, so a body search can say so', async () => {
    seedRawWebhook()
    seedDeliveryWithAttempt({ id: 'fresh' }, { responseBody: 'timeout talking to upstream' })
    // The retention job NULLs the body at 30 days and stamps `bodiesPurgedAt`.
    // Such a row can never match a body search however well it once would have.
    seedDeliveryWithAttempt(
      { id: 'purged' },
      { responseBody: null, bodiesPurgedAt: new Date('2026-01-01T00:00:00Z') },
    )

    const res = await run(() =>
      caller().support.webhooks.deliveries({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        search: 'timeout',
      }),
    )
    expect(res.items.map((d) => d.id)).toEqual(['fresh'])
    expect(res.search).toMatchObject({ term: 'timeout', purgedDeliveries: 1, retentionDays: 30 })

    // No search term, no notice — the field is the UI's cue that a body search
    // may be under-reporting, not a permanent banner.
    const unfiltered = await run(() =>
      caller().support.webhooks.deliveries({ projectId: 'proj_1', webhookId: 'wh_1' }),
    )
    expect(unfiltered.search).toBeNull()
  })
})

describe('support.webhooks.deliveries — segment counts and maxAttempts (7a)', () => {
  it('counts every segment against the other active filters, but not against the segment itself', async () => {
    seedRawWebhook()
    const inWindow = { createdAt: new Date('2026-01-10T00:00:00Z'), event: 'ticket.created' }
    seedRawDelivery({ id: 'd1', status: 'delivered', attempts: 1, ...inWindow })
    seedRawDelivery({ id: 'd2', status: 'delivered', attempts: 1, ...inWindow })
    seedRawDelivery({ id: 'f1', status: 'failed', attempts: 5, ...inWindow })
    seedRawDelivery({ id: 'r1', status: 'pending', attempts: 2, ...inWindow })
    seedRawDelivery({ id: 'q1', status: 'pending', attempts: 0, ...inWindow })
    // Excluded by the date range AND by the event chip — neither the table nor
    // any segment count may see it.
    seedRawDelivery({
      id: 'out',
      status: 'failed',
      attempts: 5,
      createdAt: new Date('2025-12-01T00:00:00Z'),
      event: 'ticket.resolved',
    })

    const failedView = await run(() =>
      caller().support.webhooks.deliveries({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        status: 'failed',
        event: 'ticket.created',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-31T00:00:00.000Z',
      }),
    )
    // Standing on "Failed" does not collapse the other counts — that is the
    // whole point of computing them without the status predicate.
    expect(failedView.counts).toEqual({ all: 5, delivered: 2, failed: 1, retrying: 1 })
    expect(failedView.items.map((d) => d.id)).toEqual(['f1'])
    // "Showing 1–1 of 1": the denominator is the segment you are on.
    expect(failedView.total).toBe(1)

    const allView = await run(() =>
      caller().support.webhooks.deliveries({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        event: 'ticket.created',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-31T00:00:00.000Z',
      }),
    )
    expect(allView.counts).toEqual(failedView.counts)
    expect(allView.total).toBe(5)
  })

  it('counts respect a search term too', async () => {
    seedRawWebhook()
    seedDeliveryWithAttempt({ id: 'hit', status: 'failed', attempts: 5 }, { responseBody: 'boom' })
    seedDeliveryWithAttempt({ id: 'miss', status: 'failed', attempts: 5 }, { responseBody: 'ok' })

    const res = await run(() =>
      caller().support.webhooks.deliveries({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        search: 'boom',
      }),
    )
    expect(res.counts).toEqual({ all: 1, delivered: 0, failed: 1, retrying: 0 })
  })

  it('carries the worker retry budget so the "3 of 5" column is not hardcoded in the UI', async () => {
    seedRawWebhook()
    seedRawDelivery({ id: 'd1' })

    const res = await run(() =>
      caller().support.webhooks.deliveries({ projectId: 'proj_1', webhookId: 'wh_1' }),
    )
    // Default matches `parse_or("INGEST_WEBHOOK_MAX_ATTEMPTS", 5)` in
    // `services/ingest/src/config.rs`, so an unset env var is still correct.
    expect(res.maxAttempts).toBe(5)

    process.env.INGEST_WEBHOOK_MAX_ATTEMPTS = '3'
    try {
      const tuned = await run(() =>
        caller().support.webhooks.deliveries({ projectId: 'proj_1', webhookId: 'wh_1' }),
      )
      expect(tuned.maxAttempts).toBe(3)
    } finally {
      process.env.INGEST_WEBHOOK_MAX_ATTEMPTS = undefined
      delete process.env.INGEST_WEBHOOK_MAX_ATTEMPTS
    }
  })
})

describe('support.webhooks.exportCsv (7a)', () => {
  it('exports the ACTIVE FILTERS, not the current page', async () => {
    seedRawWebhook()
    seedTicket({ id: 'tkt_a', number: 7, subject: 'Broken' })
    for (let i = 1; i <= 30; i++) {
      seedDeliveryWithAttempt({
        id: `f${i}`,
        status: 'failed',
        attempts: 5,
        lastStatusCode: 500,
        ticketId: 'tkt_a',
        createdAt: new Date(`2026-01-${String(i).padStart(2, '0')}T00:00:00Z`),
      })
    }
    seedRawDelivery({ id: 'ok', status: 'delivered', attempts: 1, lastStatusCode: 200 })

    const res = await run(() =>
      caller().support.webhooks.exportCsv({
        projectId: 'proj_1',
        webhookId: 'wh_1',
        status: 'failed',
      }),
    )
    // 30 rows, though a page of the same view would only have shown ~25.
    expect(res.rowCount).toBe(30)
    expect(res.capped).toBe(false)
    expect(res.cap).toBe(5000)
    const lines = res.csv.trim().split('\n')
    expect(lines).toHaveLength(31)
    expect(lines[0]).toBe(
      'delivery_id,created_at,event,status,attempt,max_attempts,response_code,latency_ms,ticket_number,ticket_id,ticket_subject,is_test,last_error',
    )
    expect(res.csv).not.toContain(',ok,')
    // The delivered row is out of the filter entirely.
    expect(res.csv.includes('\nok,')).toBe(false)
  })

  it('quotes and de-fangs a response error a customer endpoint chose', async () => {
    const { toDeliveryCsv } = await import('./support.router.js')
    const csv = toDeliveryCsv(
      [
        {
          id: 'd1',
          event: 'ticket.created',
          status: 'failed',
          attempts: 3,
          createdAt: new Date('2026-07-26T14:31:08.000Z'),
          ticketId: 'tkt_a',
          lastStatusCode: 500,
          // A comma, a quote, a newline and a spreadsheet formula, all in the
          // one field an endpoint operator controls.
          lastError: '=cmd|"/c calc"!A1, and a\nnewline',
          isTest: false,
          ticket: { number: 7, subject: 'Broken, "quoted"' },
          attempts_: [{ attempt: 3, latencyMs: 214 }],
        },
      ],
      5,
    )
    const row = csv.split('\n')[1]
    expect(row).toContain('d1,2026-07-26T14:31:08.000Z,ticket.created,failed,3,5,500,214,7,tkt_a,')
    expect(row).toContain('"Broken, ""quoted"""')
    // Leading `=` neutralized, embedded quotes doubled, whole cell quoted.
    expect(csv).toContain('"\'=cmd|""/c calc""!A1, and a')
  })

  it('caps the export and says so', async () => {
    const { toDeliveryCsv } = await import('./support.router.js')
    // The cap itself is asserted through the router in the filter test above;
    // this pins the derived status column across the three views.
    const csv = toDeliveryCsv(
      [
        {
          id: 'a',
          event: 'ping',
          status: 'delivered',
          attempts: 1,
          createdAt: '2026-07-26T00:00:00.000Z',
          ticketId: null,
          lastStatusCode: 200,
          lastError: null,
          isTest: true,
          ticket: null,
          attempts_: [{ attempt: 1, latencyMs: 30 }],
        },
        {
          id: 'b',
          event: 'ticket.created',
          status: 'pending',
          attempts: 0,
          createdAt: '2026-07-26T00:00:00.000Z',
          ticketId: null,
          lastStatusCode: null,
          lastError: null,
          isTest: false,
          ticket: null,
        },
      ],
      5,
    )
    const [, delivered, queued] = csv.split('\n')
    expect(delivered.split(',')[3]).toBe('delivered')
    // `pending` with no attempt behind it is queued, NOT retrying — same
    // derivation the status chip uses (constraint 1).
    expect(queued.split(',')[3]).toBe('pending')
    // No response at all leaves the code and latency cells empty rather than 0.
    expect(queued.split(',')[6]).toBe('')
    expect(queued.split(',')[7]).toBe('')
  })

  it('404s for a webhook outside the project before reading anything', async () => {
    await expect(
      run(() => caller().support.webhooks.exportCsv({ projectId: 'proj_1', webhookId: 'wh_nope' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('support.webhooks raw-SQL surfaces', () => {
  // NOTE: `health`, `stats` and `reEnableAndReplay`'s stagger are `$queryRaw` /
  // `$executeRaw`. This suite has in-memory Prisma stubs and NO SQL engine, so
  // the window function, the `FILTER` aggregates and the `row_number()` stagger
  // CANNOT be executed here. These tests assert what a stub CAN prove — that the
  // procedure runs, that constraint 4's hand-bound `projectId` is actually in
  // the statement, and that the transactional model writes land. The SQL's own
  // behaviour is verified against a live Postgres in steps 8/11/12.

  it('health binds projectId by hand (constraint 4) and maps rows through the pure function', async () => {
    rawQueryResult = [
      {
        webhookId: 'wh_1',
        considered: 20n,
        failures: 0n,
        p95_latency_ms: 140,
        last_delivery_at: null,
      },
      {
        webhookId: 'wh_2',
        considered: 20n,
        failures: 9n,
        p95_latency_ms: 220,
        last_delivery_at: null,
      },
      {
        webhookId: 'wh_3',
        considered: 0n,
        failures: 0n,
        p95_latency_ms: null,
        last_delivery_at: null,
      },
    ]

    const res = await run(() => caller().support.webhooks.health({ projectId: 'proj_1' }))
    expect(res.map((r) => r.health)).toEqual(['healthy', 'failing', 'idle'])
    expect(res[0]).toMatchObject({ webhookId: 'wh_1', considered: 20, failures: 0 })

    // ONE query for the whole project (constraint 8) — no per-webhook read.
    expect(rawQueries).toHaveLength(1)
    // Tenancy is the hand-written bind; `$extends` does not reach `$queryRaw`.
    expect(rawQueries[0].sql).toContain('w."projectId" = ')
    expect(rawQueries[0].values).toContain('proj_1')
    // Tests never colour the chip.
    expect(rawQueries[0].sql).toContain('d."isTest" = false')
  })

  it('stats requires the webhook first, then binds projectId in the raw query too', async () => {
    seedRawWebhook()
    rawQueryResult = [{ delivered_24h: 7n, delivered: 9n, failed: 1n, p95_latency_ms: 320 }]

    const res = await run(() =>
      caller().support.webhooks.stats({ projectId: 'proj_1', webhookId: 'wh_1' }),
    )
    expect(res).toEqual({ delivered24h: 7, failed: 1, successRate: 0.9, p95LatencyMs: 320 })
    expect(rawQueries[0].sql).toContain('w."projectId" = ')
    expect(rawQueries[0].values).toEqual(expect.arrayContaining(['proj_1', 'wh_1']))

    // A hook in another project 404s before any SQL runs.
    rawQueries = []
    await expect(
      run(() => caller().support.webhooks.stats({ projectId: 'proj_1', webhookId: 'wh_nope' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(rawQueries).toHaveLength(0)
  })

  it('stats reports a 0 success rate rather than NaN with nothing terminal yet', async () => {
    seedRawWebhook()
    rawQueryResult = [{ delivered_24h: 0n, delivered: 0n, failed: 0n, p95_latency_ms: null }]
    const res = await run(() =>
      caller().support.webhooks.stats({ projectId: 'proj_1', webhookId: 'wh_1' }),
    )
    expect(res).toEqual({ delivered24h: 0, failed: 0, successRate: 0, p95LatencyMs: null })
  })

  it('volume asks Postgres for every hour, binds the project by hand and skips tests', async () => {
    seedRawWebhook()
    rawQueryResult = [
      { hour_start: new Date('2026-07-26T13:00:00Z'), delivered: 4n, failed: 1n },
      { hour_start: new Date('2026-07-26T14:00:00Z'), delivered: 0n, failed: 0n },
    ]
    const res = await run(() =>
      caller().support.webhooks.volume({ projectId: 'proj_1', webhookId: 'wh_1' }),
    )
    expect(res).toEqual([
      { hourStart: new Date('2026-07-26T13:00:00Z'), delivered: 4, failed: 1 },
      { hourStart: new Date('2026-07-26T14:00:00Z'), delivered: 0, failed: 0 },
    ])

    const [sql] = rawQueries
    expect(rawQueries).toHaveLength(1)
    // `generate_series` over `date_trunc('hour', …)` is what makes an empty
    // hour arrive as a zero bar instead of being missing and shifting the
    // chart; without it the 24-bar chart silently misaligns.
    expect(sql.sql).toContain("generate_series(from_hour, to_hour, interval '1 hour')")
    expect(sql.sql).toContain("date_trunc('hour'")
    // Default window: the last 24 whole hours, so `now()` with no `from`/`to`.
    expect(sql.sql).toContain("to_hour - interval '23 hours'")
    // Tenancy is bound by hand — `$extends` does not reach `$queryRaw`.
    expect(sql.sql).toContain('w."projectId" = ')
    expect(sql.values).toEqual(expect.arrayContaining(['proj_1', 'wh_1']))
    // ...inside the LEFT JOIN's ON clause, not the WHERE, or the empty buckets
    // would be filtered away again.
    expect(sql.sql).not.toContain('WHERE b.')
    // Test deliveries are out, matching the health rollup.
    expect(sql.sql).toContain('d."isTest" = false')
  })

  it('volume 404s for a webhook outside the project before any SQL runs', async () => {
    await expect(
      run(() => caller().support.webhooks.volume({ projectId: 'proj_1', webhookId: 'wh_nope' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(rawQueries).toHaveLength(0)
  })

  it('reEnableAndReplay clears the auto-disable and staggers by createdAt in one transaction', async () => {
    seedRawWebhook({ active: false, autoDisabledAt: new Date(), consecutiveFailures: 20 })
    seedRawDelivery({ id: 'first', createdAt: new Date('2026-01-01T00:00:00Z') })
    seedRawDelivery({ id: 'second', createdAt: new Date('2026-01-02T00:00:00Z') })

    const res = await run(() =>
      caller().support.webhooks.reEnableAndReplay({ projectId: 'proj_1', id: 'wh_1' }),
    )
    expect(res).toMatchObject({ id: 'wh_1', active: true })

    // The circuit breaker is fully reset, otherwise one more terminal failure
    // would re-trip it immediately.
    expect(webhooks[0]).toMatchObject({
      active: true,
      autoDisabledAt: null,
      consecutiveFailures: 0,
    })

    // The stagger is the specced `row_number()` statement, ordered by
    // `createdAt ASC` and spread one second apart — which, combined with the
    // worker's `ORDER BY d."nextAttemptAt" ASC, d."createdAt" ASC`, is
    // what makes in-order replay real. The stub has no SQL engine, so this
    // asserts the statement's shape and binds, not the resulting row order.
    const [stagger] = rawQueries
    expect(rawQueries).toHaveLength(1)
    expect(stagger.sql).toContain('row_number() OVER (ORDER BY "createdAt" ASC)')
    expect(stagger.sql).toContain('make_interval(secs => r.rn - 1)')
    expect(stagger.sql).toContain('"status" = \'pending\'')
    expect(stagger.sql).toContain('"attempts" = 0')
    expect(stagger.values).toContain('wh_1')
  })
})

describe('empty events[] subscribes to everything', () => {
  it('matches every event on the TS side, as both Rust readers already do', async () => {
    seedTicket()
    // A row the API cannot produce (`events` carries `.min(1)`), but which old
    // or hand-inserted data can: `cardinality(events) = 0`. capture-rs and the
    // delivery worker both treat it as subscribe-to-EVERYTHING; before this fix
    // the TS `has` predicate treated it as subscribe-to-nothing, so the same row
    // meant opposite things depending on which writer enqueued.
    webhooks.push({
      id: 'wh_catchall',
      projectId: 'proj_1',
      url: 'https://example.com/hook',
      secret: 'enc',
      events: [],
      active: true,
      deletedAt: null,
    })

    await run(() =>
      caller().support.tickets.reply({ projectId: 'proj_1', id: 'tkt_1', body: 'hi' }),
    )
    expect(deliveries.map((d) => d.event)).toEqual(['ticket.replied'])

    await run(() =>
      caller().support.tickets.setStatus({ projectId: 'proj_1', id: 'tkt_1', status: 'resolved' }),
    )
    await run(() =>
      caller().support.tickets.setStatus({ projectId: 'proj_1', id: 'tkt_1', status: 'open' }),
    )
    expect(deliveries.map((d) => d.event)).toEqual([
      'ticket.replied',
      'ticket.resolved',
      'ticket.reopened',
    ])
    expect(deliveries.every((d) => d.webhookId === 'wh_catchall')).toBe(true)
  })

  it('still does not deliver to an inactive or deleted catch-all', async () => {
    seedTicket()
    webhooks.push({
      id: 'wh_off',
      projectId: 'proj_1',
      url: 'https://example.com/off',
      secret: 'enc',
      events: [],
      active: false,
      deletedAt: null,
    })
    webhooks.push({
      id: 'wh_gone',
      projectId: 'proj_1',
      url: 'https://example.com/gone',
      secret: 'enc',
      events: [],
      active: true,
      deletedAt: new Date(),
    })
    await run(() =>
      caller().support.tickets.reply({ projectId: 'proj_1', id: 'tkt_1', body: 'hi' }),
    )
    expect(deliveries).toHaveLength(0)
  })
})

describe('support.results (Postgres-backed)', () => {
  it('counts open + pending tickets regardless of the range', async () => {
    seedTicket({ id: 't1', status: 'open' })
    seedTicket({ id: 't2', status: 'pending' })
    seedTicket({ id: 't3', status: 'resolved' })
    seedTicket({ id: 't4', status: 'open', formId: 'other' })

    const res = await run(() =>
      caller().support.results.openCount({ projectId: 'proj_1', formId: 'form_1', range: RANGE }),
    )
    expect(res).toEqual({ open: 1, pending: 1, total: 2 })
  })

  it('computes the median first-reply time over replied tickets in range', async () => {
    seedTicket({
      id: 't1',
      createdAt: new Date('2026-01-05T00:00:00.000Z'),
      firstReplyAt: new Date('2026-01-05T00:01:00.000Z'), // 60s
    })
    seedTicket({
      id: 't2',
      createdAt: new Date('2026-01-06T00:00:00.000Z'),
      firstReplyAt: new Date('2026-01-06T00:05:00.000Z'), // 300s
    })
    seedTicket({
      id: 't3',
      createdAt: new Date('2026-01-07T00:00:00.000Z'),
      firstReplyAt: new Date('2026-01-07T00:02:00.000Z'), // 120s
    })
    // Never replied -> excluded. Outside the range -> excluded.
    seedTicket({ id: 't4' })
    seedTicket({
      id: 't5',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      firstReplyAt: new Date('2025-01-01T10:00:00.000Z'),
    })

    const res = await run(() =>
      caller().support.results.firstReplyTime({
        projectId: 'proj_1',
        formId: 'form_1',
        range: RANGE,
      }),
    )
    expect(res).toEqual({ replied: 3, medianSeconds: 120 })
  })
})
