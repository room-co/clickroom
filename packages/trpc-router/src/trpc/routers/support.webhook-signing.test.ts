import { describe, expect, it } from 'vitest'
import {
  createSupportWebhookInput,
  supportWebhookEventSchema,
  updateSupportWebhookInput,
} from './support.schema'
import {
  admitWebhookUrl,
  isHttpsWebhookUrl,
  isPrivateAddress,
  signWebhookBody,
  webhookSignatureHeader,
} from './support.webhook-signing'

// ── The cross-language contract ─────────────────────────────────────────────

describe('signWebhookBody', () => {
  /**
   * KEEP IN SYNC WITH `signs_the_known_vector` in
   * `services/ingest/src/webhook_job.rs:533`. This exact secret + timestamp +
   * body must produce this exact hex on BOTH sides, or every customer's
   * verification snippet silently starts rejecting deliveries from whichever
   * implementation drifted. This is the one test that catches that.
   */
  it('signs the known cross-language vector', () => {
    const body = '{"event":"ticket.created","ticket":{"id":"01J0000000000000000000"}}'
    expect(signWebhookBody('whsec_super_secret', 1_700_000_000, body)).toBe(
      'c763e080b109ec6a96e6b09e2e931e677a2a29bb6b767321a1169959504114f6',
    )
  })

  it('depends on the secret (guards against an accidental keyless hash)', () => {
    expect(signWebhookBody('a', 1, 'body')).not.toBe(signWebhookBody('b', 1, 'body'))
  })

  it('covers the timestamp, so a replay under a fresh `t` invalidates v1', () => {
    const body = '{"event":"ticket.created"}'
    expect(signWebhookBody('whsec_super_secret', 1_700_000_000, body)).not.toBe(
      signWebhookBody('whsec_super_secret', 1_700_000_001, body),
    )
  })

  it('joins `t` and the body unambiguously', () => {
    expect(signWebhookBody('s', 17, '00.{}')).not.toBe(signWebhookBody('s', 1_700, '{}'))
  })
})

// ── Rotation grace window ───────────────────────────────────────────────────

describe('webhookSignatureHeader', () => {
  const secret = 'whsec_new_secret'
  const previousSecret = 'whsec_super_secret'
  const t = 1_700_000_000
  const body = '{"event":"ticket.created"}'

  it('emits single-v1 shape when no rotation is in grace', () => {
    expect(webhookSignatureHeader(secret, null, t, body)).toBe(
      `t=${t},v1=${signWebhookBody(secret, t, body)}`,
    )
  })

  it('keeps v1 on the PREVIOUS secret and adds v2 for the new one during grace', () => {
    const header = webhookSignatureHeader(
      secret,
      { secret: previousSecret, expiresAt: new Date((t + 3600) * 1000) },
      t,
      body,
    )
    expect(header).toBe(
      `t=${t},v1=${signWebhookBody(previousSecret, t, body)},v2=${signWebhookBody(secret, t, body)}`,
    )
  })

  /**
   * The whole reason this is `v1`-old/`v2`-new rather than Stripe's dual-`v1`:
   * a verifier that splits on `,v1=` and takes one value keeps validating for
   * the entire window, so rotating a secret cannot cause a silent 24h outage.
   */
  it('leaves a naive single-v1 verifier working for the whole window', () => {
    const header = webhookSignatureHeader(
      secret,
      { secret: previousSecret, expiresAt: new Date((t + 3600) * 1000) },
      t,
      body,
    )
    const v1 = header.split(',v1=')[1]?.split(',')[0]
    expect(v1).toBe(signWebhookBody(previousSecret, t, body))
    expect(header.split('v1=')).toHaveLength(2)
  })

  it('drops the previous secret once the grace window has expired', () => {
    const header = webhookSignatureHeader(
      secret,
      { secret: previousSecret, expiresAt: new Date((t - 1) * 1000) },
      t,
      body,
    )
    expect(header).toBe(`t=${t},v1=${signWebhookBody(secret, t, body)}`)
    expect(header).not.toContain('v2=')
  })

  it('treats an expiry exactly at `t` as expired', () => {
    const header = webhookSignatureHeader(
      secret,
      { secret: previousSecret, expiresAt: new Date(t * 1000) },
      t,
      body,
    )
    expect(header).not.toContain('v2=')
  })
})

// ── SSRF guard ──────────────────────────────────────────────────────────────

describe('isPrivateAddress', () => {
  const privateAddresses = [
    '127.0.0.1',
    '127.10.20.30',
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud instance metadata
    '100.64.0.1', // CGNAT
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1', // IPv6 ULA
    'fd12:3456:789a::1', // IPv6 ULA
    'fe80::1', // link-local
    'ff02::1', // multicast
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    'not-an-ip', // fails closed
  ]

  const publicAddresses = [
    '1.1.1.1',
    '8.8.8.8',
    '172.32.0.1',
    '192.169.0.1',
    '99.99.99.99',
    '2606:4700:4700::1111',
  ]

  it.each(privateAddresses)('rejects %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true)
  })

  it.each(publicAddresses)('accepts %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false)
  })
})

describe('admitWebhookUrl', () => {
  const resolvesTo =
    (...addresses: string[]) =>
    async () =>
      addresses

  it('accepts a public HTTPS host', async () => {
    const result = await admitWebhookUrl(
      'https://hooks.example.com/inbound',
      resolvesTo('93.184.216.34'),
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.addresses).toEqual(['93.184.216.34'])
  })

  it('rejects http:// before any DNS happens', async () => {
    const result = await admitWebhookUrl('http://hooks.example.com/inbound', async () => {
      throw new Error('resolver must not be reached')
    })
    expect(result).toMatchObject({ ok: false, reason: 'not_https' })
  })

  it('rejects a non-URL string', async () => {
    expect(await admitWebhookUrl('nope')).toMatchObject({ ok: false, reason: 'invalid_url' })
  })

  it.each([
    ['loopback', '127.0.0.1'],
    ['RFC1918 10/8', '10.1.2.3'],
    ['RFC1918 172.16/12', '172.20.5.5'],
    ['RFC1918 192.168/16', '192.168.0.10'],
    ['link-local / metadata', '169.254.169.254'],
    ['IPv6 ULA', 'fd00::1'],
    ['IPv6 link-local', 'fe80::abcd'],
    ['IPv6 loopback', '::1'],
  ])('rejects a public hostname resolving to %s', async (_label, address) => {
    const result = await admitWebhookUrl('https://evil.example.com/hook', resolvesTo(address))
    expect(result).toMatchObject({ ok: false, reason: 'private_address' })
  })

  it('rejects when ANY resolved address is private, not just the first', async () => {
    const result = await admitWebhookUrl(
      'https://rebind.example.com/hook',
      resolvesTo('93.184.216.34', '127.0.0.1'),
    )
    expect(result).toMatchObject({ ok: false, reason: 'private_address' })
  })

  it('rejects a private IP literal without consulting DNS', async () => {
    const result = await admitWebhookUrl('https://127.0.0.1:8443/hook', async () => {
      throw new Error('resolver must not be reached')
    })
    expect(result).toMatchObject({ ok: false, reason: 'private_address' })
  })

  it('rejects a bracketed IPv6 loopback literal', async () => {
    expect(await admitWebhookUrl('https://[::1]/hook')).toMatchObject({
      ok: false,
      reason: 'private_address',
    })
  })

  it('rejects a host that does not resolve', async () => {
    const result = await admitWebhookUrl('https://nx.example.com/hook', async () => {
      throw new Error('ENOTFOUND')
    })
    expect(result).toMatchObject({ ok: false, reason: 'unresolvable' })
  })

  it('rejects a host that resolves to nothing at all', async () => {
    const result = await admitWebhookUrl('https://nx.example.com/hook', resolvesTo())
    expect(result).toMatchObject({ ok: false, reason: 'unresolvable' })
  })
})

// ── The zod predicates that mirror the guard ────────────────────────────────

describe('isHttpsWebhookUrl', () => {
  it('matches the zod refinement it mirrors', () => {
    expect(isHttpsWebhookUrl('https://hooks.example.com')).toBe(true)
    expect(isHttpsWebhookUrl('http://hooks.example.com')).toBe(false)
    expect(isHttpsWebhookUrl('ftp://hooks.example.com')).toBe(false)
    expect(isHttpsWebhookUrl('nonsense')).toBe(false)
  })
})

describe('webhook input schemas', () => {
  const base = { projectId: 'proj_1', name: 'Zendesk', events: ['ticket.created'] }

  it('rejects a non-HTTPS endpoint at the form, not at delivery time', () => {
    const result = createSupportWebhookInput.safeParse({ ...base, url: 'http://example.com/hook' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('Endpoint URL must be https://')
    }
    expect(
      createSupportWebhookInput.safeParse({ ...base, url: 'https://example.com/hook' }).success,
    ).toBe(true)
  })

  it('requires a name of 1..80 characters', () => {
    const url = 'https://example.com/hook'
    expect(createSupportWebhookInput.safeParse({ ...base, url, name: undefined }).success).toBe(
      false,
    )
    expect(createSupportWebhookInput.safeParse({ ...base, url, name: '' }).success).toBe(false)
    expect(createSupportWebhookInput.safeParse({ ...base, url, name: 'a' }).success).toBe(true)
    expect(
      createSupportWebhookInput.safeParse({ ...base, url, name: 'a'.repeat(80) }).success,
    ).toBe(true)
    expect(
      createSupportWebhookInput.safeParse({ ...base, url, name: 'a'.repeat(81) }).success,
    ).toBe(false)
  })

  it('applies the same name and HTTPS rules to the patch', () => {
    const patch = (p: Record<string, unknown>) =>
      updateSupportWebhookInput.safeParse({ id: 'wh_1', projectId: 'proj_1', patch: p }).success
    expect(patch({ name: 'Renamed' })).toBe(true)
    expect(patch({ name: '' })).toBe(false)
    expect(patch({ name: 'a'.repeat(81) })).toBe(false)
    expect(patch({ url: 'http://example.com' })).toBe(false)
    expect(patch({ url: 'https://example.com' })).toBe(true)
  })

  it('carries `ticket.reopened` and keeps every wire name', () => {
    expect(supportWebhookEventSchema.options).toEqual([
      'ticket.created',
      'ticket.replied',
      'ticket.updated',
      'ticket.resolved',
      'ticket.reopened',
    ])
  })
})
