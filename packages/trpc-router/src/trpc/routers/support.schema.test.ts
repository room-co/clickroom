import { describe, expect, it } from 'vitest'
import {
  exportSupportWebhookDeliveriesInput,
  listSupportTicketsInput,
  listSupportWebhookDeliveriesInput,
  supportBugReportSchema,
  supportDefinitionSchema,
  supportTicketPayloadSchema,
  supportWebhookDeliveryEventFilterSchema,
  supportWebhookEventSchema,
  supportWebhookVolumeInput,
} from './support.schema'

// A minimal valid definition. Subject + Message are structural (always rendered by the widget,
// validated separately by capture-rs), so `fields` holds only extra custom fields — and may be
// empty.
const baseDefinition = () => ({
  version: 1 as const,
  channel: 'contact' as const,
  fields: [] as Array<Record<string, unknown>>,
  appearance: { layout: 'launcher' as const, position: 'bottom_right' as const },
  tracking: {},
  routing: {},
  triggers: {},
})

describe('supportDefinitionSchema — structural field guard', () => {
  it('accepts a definition with no custom fields (structural Subject/Message suffice)', () => {
    const result = supportDefinitionSchema.safeParse(baseDefinition())
    expect(result.success).toBe(true)
  })

  it('accepts genuine extra custom fields', () => {
    const def = baseDefinition()
    def.fields = [{ id: 'email', type: 'email', label: 'Email', required: true }]
    expect(supportDefinitionSchema.safeParse(def).success).toBe(true)
  })

  it.each([
    ['Subject', 'short_text'],
    ['subject', 'short_text'],
    ['  Subject  ', 'short_text'],
    ['Message', 'long_text'],
    ['message', 'long_text'],
  ])('rejects a custom field that duplicates a structural field (label %j)', (label, type) => {
    const def = baseDefinition()
    def.fields = [{ id: 'f_1', type, label, required: true }]
    const result = supportDefinitionSchema.safeParse(def)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('built-in field')
      expect(result.error.issues[0]?.path).toEqual(['fields', 0, 'label'])
    }
  })

  it.each([
    'subject',
    '$subject',
    'body',
    '$body',
  ])('rejects a custom field using a reserved id (%s)', (id) => {
    const def = baseDefinition()
    def.fields = [{ id, type: 'short_text', label: 'Anything', required: true }]
    expect(supportDefinitionSchema.safeParse(def).success).toBe(false)
  })
})

// ── — bug payload + the additive `bugContext` tracking key ──────────

describe('supportTicketPayloadSchema — discriminated ticket payload', () => {
  it('accepts the bare conversation variant', () => {
    const result = supportTicketPayloadSchema.safeParse({ type: 'conversation' })
    expect(result.success).toBe(true)
  })

  it.each([
    ['severity', { type: 'conversation', severity: 'blocker' }],
    ['bugReport', { type: 'conversation', bugReport: { capturedAt: 'x' } }],
  ])('rejects a conversation carrying %s (strict, bug-only keys)', (_label, payload) => {
    expect(supportTicketPayloadSchema.safeParse(payload).success).toBe(false)
  })

  it('accepts a bug with severity and a full bug report', () => {
    const result = supportTicketPayloadSchema.safeParse({
      type: 'bug',
      severity: 'major',
      bugReport: {
        capturedAt: '2026-07-25T00:00:00.000Z',
        environment: { url: 'https://example.com', browser: 'Chrome', viewportWidth: 1280 },
        consoleErrors: [{ level: 'error', message: 'boom', timestamp: '2026-07-25T00:00:00.000Z' }],
        networkErrors: [
          { method: 'POST', url: 'https://api.example.com', status: null, timestamp: 'now' },
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a bug with severity/bugReport null or absent', () => {
    expect(supportTicketPayloadSchema.safeParse({ type: 'bug' }).success).toBe(true)
    expect(
      supportTicketPayloadSchema.safeParse({ type: 'bug', severity: null, bugReport: null })
        .success,
    ).toBe(true)
  })

  it.each(['critical', 'BLOCKER', ''])('rejects an off-list severity (%j)', (severity) => {
    expect(supportTicketPayloadSchema.safeParse({ type: 'bug', severity }).success).toBe(false)
  })

  it('rejects an unknown discriminator', () => {
    expect(supportTicketPayloadSchema.safeParse({ type: 'incident' }).success).toBe(false)
  })

  it('rejects unknown keys inside the bug report and its nested objects', () => {
    const base = { capturedAt: '2026-07-25T00:00:00.000Z' }
    expect(supportBugReportSchema.safeParse({ ...base, screenshot: 'data:...' }).success).toBe(
      false,
    )
    expect(
      supportBugReportSchema.safeParse({ ...base, environment: { cookies: 'session=1' } }).success,
    ).toBe(false)
  })

  it('caps the console/network rings at 20 entries', () => {
    const entry = { level: 'error' as const, message: 'e', timestamp: 't' }
    const at20 = { capturedAt: 't', consoleErrors: Array.from({ length: 20 }, () => entry) }
    const at21 = { capturedAt: 't', consoleErrors: Array.from({ length: 21 }, () => entry) }
    expect(supportBugReportSchema.safeParse(at20).success).toBe(true)
    expect(supportBugReportSchema.safeParse(at21).success).toBe(false)
  })
})

describe('supportTrackingSchema.bugContext — additive, default OFF', () => {
  it('defaults bugContext to false when tracking omits it', () => {
    const parsed = supportDefinitionSchema.parse(baseDefinition())
    expect(parsed.tracking.bugContext).toBe(false)
  })

  it('still parses a v1 definition saved before this phase (every tracking key explicit)', () => {
    const def = {
      ...baseDefinition(),
      tracking: {
        identity: true,
        formAnalytics: true,
        recentEvents: true,
        sessionReplay: false,
      },
    }
    const parsed = supportDefinitionSchema.parse(def)
    // version stays 1 — the new key is purely additive, no union, no migration.
    expect(parsed.version).toBe(1)
    expect(parsed.tracking).toMatchObject({ identity: true, bugContext: false })
  })

  it('round-trips an explicit opt-in', () => {
    const def = { ...baseDefinition(), tracking: { bugContext: true } }
    expect(supportDefinitionSchema.parse(def).tracking.bugContext).toBe(true)
  })
})

describe('listSupportTicketsInput — type/severity filters', () => {
  it('accepts type and severity', () => {
    const parsed = listSupportTicketsInput.parse({
      projectId: 'proj_1',
      type: 'bug',
      severity: 'blocker',
    })
    expect(parsed).toMatchObject({ type: 'bug', severity: 'blocker' })
  })

  it('leaves both undefined when omitted (the "All" tab)', () => {
    const parsed = listSupportTicketsInput.parse({ projectId: 'proj_1' })
    expect(parsed.type).toBeUndefined()
    expect(parsed.severity).toBeUndefined()
  })

  it('rejects off-list values', () => {
    expect(
      listSupportTicketsInput.safeParse({ projectId: 'proj_1', type: 'incident' }).success,
    ).toBe(false)
    expect(
      listSupportTicketsInput.safeParse({ projectId: 'proj_1', severity: 'critical' }).success,
    ).toBe(false)
  })
})

describe('listSupportWebhookDeliveriesInput — scoped delivery history', () => {
  const base = { projectId: 'proj_1', webhookId: 'wh_1' }

  it('defaults limit to 50, status to `all`, and leaves the rest unset', () => {
    const parsed = listSupportWebhookDeliveriesInput.parse(base)
    expect(parsed.limit).toBe(50)
    expect(parsed.status).toBe('all')
    expect(parsed.from).toBeUndefined()
    expect(parsed.to).toBeUndefined()
    expect(parsed.cursor).toBeUndefined()
  })

  it('requires webhookId — history is never project-wide', () => {
    expect(listSupportWebhookDeliveriesInput.safeParse({ projectId: 'proj_1' }).success).toBe(false)
  })

  it('accepts the four filter views and rejects anything else', () => {
    for (const status of ['all', 'delivered', 'failed', 'retrying']) {
      expect(listSupportWebhookDeliveriesInput.safeParse({ ...base, status }).success).toBe(true)
    }
    // `pending` is a stored status, not a filter view — the sheet says "Retrying".
    expect(
      listSupportWebhookDeliveriesInput.safeParse({ ...base, status: 'pending' }).success,
    ).toBe(false)
    expect(listSupportWebhookDeliveriesInput.safeParse({ ...base, status: 'nope' }).success).toBe(
      false,
    )
  })

  it('takes an ISO from/to range and rejects a non-ISO one', () => {
    expect(
      listSupportWebhookDeliveriesInput.safeParse({
        ...base,
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-26T00:00:00.000Z',
      }).success,
    ).toBe(true)
    expect(
      listSupportWebhookDeliveriesInput.safeParse({ ...base, from: '2026-07-01' }).success,
    ).toBe(false)
  })

  it('rejects unknown keys', () => {
    expect(
      listSupportWebhookDeliveriesInput.safeParse({ ...base, includeSecret: true }).success,
    ).toBe(false)
  })

  it('rejects an out-of-range or fractional limit', () => {
    for (const limit of [0, 101, 1.5]) {
      expect(listSupportWebhookDeliveriesInput.safeParse({ ...base, limit }).success).toBe(false)
    }
  })

  it('takes every subscribable event plus ping, and nothing else', () => {
    // The delivery table CONTAINS ping rows (`sendTest` writes them), so the
    // filter has to be able to name one even though nobody subscribes to it.
    expect([...supportWebhookDeliveryEventFilterSchema.options].sort()).toEqual(
      [...supportWebhookEventSchema.options, 'ping'].sort(),
    )
    expect(listSupportWebhookDeliveriesInput.safeParse({ ...base, event: 'ping' }).success).toBe(
      true,
    )
    expect(
      listSupportWebhookDeliveriesInput.safeParse({ ...base, event: 'ticket.created' }).success,
    ).toBe(true)
    expect(
      listSupportWebhookDeliveriesInput.safeParse({ ...base, event: 'ticket.exploded' }).success,
    ).toBe(false)
  })

  it('bounds the response code range to real HTTP codes and refuses an inverted one', () => {
    expect(
      listSupportWebhookDeliveriesInput.safeParse({
        ...base,
        responseCodeMin: 500,
        responseCodeMax: 599,
      }).success,
    ).toBe(true)
    for (const bad of [
      { responseCodeMin: 99 },
      { responseCodeMax: 600 },
      { responseCodeMin: 4.5 },
    ]) {
      expect(listSupportWebhookDeliveriesInput.safeParse({ ...base, ...bad }).success).toBe(false)
    }
    // min > max selects nothing at all — refuse it rather than return an empty page.
    expect(
      listSupportWebhookDeliveriesInput.safeParse({
        ...base,
        responseCodeMin: 500,
        responseCodeMax: 400,
      }).success,
    ).toBe(false)
  })

  it('trims the search term and refuses a blank or oversized one', () => {
    const parsed = listSupportWebhookDeliveriesInput.parse({ ...base, search: '  tkt_1  ' })
    expect(parsed.search).toBe('tkt_1')
    expect(listSupportWebhookDeliveriesInput.safeParse({ ...base, search: '   ' }).success).toBe(
      false,
    )
    expect(
      listSupportWebhookDeliveriesInput.safeParse({ ...base, search: 'x'.repeat(201) }).success,
    ).toBe(false)
  })
})

describe('exportSupportWebhookDeliveriesInput — same filters, no pagination', () => {
  const base = { projectId: 'proj_1', webhookId: 'wh_1' }

  it('accepts every filter field `deliveries` takes', () => {
    const parsed = exportSupportWebhookDeliveriesInput.parse({
      ...base,
      status: 'failed',
      event: 'ticket.created',
      search: 'boom',
      responseCodeMin: 500,
      responseCodeMax: 599,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-26T00:00:00.000Z',
    })
    expect(parsed.status).toBe('failed')
    expect(parsed.search).toBe('boom')
  })

  it('refuses cursor/limit — the export is the whole filtered set, not a page', () => {
    expect(exportSupportWebhookDeliveriesInput.safeParse({ ...base, limit: 10 }).success).toBe(
      false,
    )
    expect(exportSupportWebhookDeliveriesInput.safeParse({ ...base, cursor: 'd1' }).success).toBe(
      false,
    )
  })
})

describe('supportWebhookVolumeInput — hourly chart window', () => {
  it('leaves from/to optional so the chart defaults to the last 24 hours', () => {
    const parsed = supportWebhookVolumeInput.parse({ projectId: 'proj_1', webhookId: 'wh_1' })
    expect(parsed.from).toBeUndefined()
    expect(parsed.to).toBeUndefined()
  })

  it('rejects a non-ISO range and unknown keys', () => {
    const base = { projectId: 'proj_1', webhookId: 'wh_1' }
    expect(supportWebhookVolumeInput.safeParse({ ...base, from: '2026-07-01' }).success).toBe(false)
    expect(supportWebhookVolumeInput.safeParse({ ...base, buckets: 48 }).success).toBe(false)
  })
})
