/**
 * Integration tests for SSO — SAML assertion validation (task.
 *
 * A self-signed RSA cert/key is minted in-test (see `helpers/saml-fixture.ts`) and
 * used to sign real SAML 2.0 assertions, so these tests drive the genuine
 * `@node-saml/node-saml` validation path — signature, audience, conditions/expiry,
 * issuer — rather than mocks.
 *
 * Two layers are exercised:
 *  1. A node-saml `SAML` instance built with the EXACT config our production
 *     `buildSamlConfig` uses, plus a seeded InResponseTo cache. This lets us assert
 *     the security rejections (bad signature, audience mismatch, expired) that
 *     node-saml enforces, and that a valid assertion yields the expected profile.
 *  2. The production `validateSamlResponse` + `assertAssertionNotReplayed` helpers
 *     directly, for the replay guard and the InResponseTo CSRF guard.
 *
 * Why the seeded-cache layer: production `validateSamlResponse` constructs a fresh
 * `SAML` instance per call with `validateInResponseTo: 'always'` and its own
 * in-memory request-ID cache. That cache cannot be seeded from a test without an
 * actual prior `buildSamlAuthRequest` on the same instance, so a fully-correlated
 * happy path through `validateSamlResponse` is not unit-testable in isolation. We
 * therefore reproduce node-saml's validation under the identical config with a
 * controllable cache to exercise the security assertions, and separately verify the
 * production helper rejects an uncorrelated response (the InResponseTo guard).
 */

import {
  assertAssertionNotReplayed,
  validateSamlResponse,
} from '@clickroom/trpc-router/http/sso/saml.js'
import { SAML, type SamlConfig } from '@node-saml/node-saml'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildSignedSamlResponse,
  generateIdpKeyMaterial,
  type SamlIdpKeyMaterial,
} from './helpers/saml-fixture.js'

const IDP_ENTITY_ID = 'https://idp.test/entity'
const IDP_SSO_URL = 'https://idp.test/sso'
const SP_ENTITY_ID = 'https://sp.clickroom.test/entity'
const ACS_URL = 'https://sp.clickroom.test/acs'

let km: SamlIdpKeyMaterial

beforeAll(() => {
  km = generateIdpKeyMaterial()
})

/** A minimal seedable in-memory cache implementing node-saml's CacheProvider. */
function makeCache() {
  const store = new Map<string, { createdAt: number; value: string }>()
  return {
    saveAsync: async (key: string, value: string) => {
      const item = { createdAt: Date.now(), value }
      store.set(key, item)
      return item
    },
    getAsync: async (key: string) => store.get(key)?.value ?? null,
    removeAsync: async (key: string) => {
      store.delete(key)
      return key
    },
  }
}

/**
 * Build a `SAML` instance mirroring production `buildSamlConfig`, plus a seeded
 * InResponseTo cache so we can validate correlated IdP responses.
 */
async function makeSaml(requestId: string) {
  const cacheProvider = makeCache()
  await cacheProvider.saveAsync(requestId, new Date().toISOString())
  const config: SamlConfig = {
    idpCert: km.certBase64,
    issuer: SP_ENTITY_ID,
    callbackUrl: ACS_URL,
    entryPoint: IDP_SSO_URL,
    idpIssuer: IDP_ENTITY_ID,
    audience: SP_ENTITY_ID,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: 'always' as SamlConfig['validateInResponseTo'],
    identifierFormat: null,
    // biome-ignore lint/suspicious/noExplicitAny: minimal cache provider shape
    cacheProvider: cacheProvider as any,
  }
  return new SAML(config)
}

function baseResponse(overrides: Partial<Parameters<typeof buildSignedSamlResponse>[0]> = {}) {
  const requestId = `_req_${Math.random().toString(36).slice(2)}`
  const { samlResponse, assertionId } = buildSignedSamlResponse({
    privateKey: km.privateKey,
    certBase64: km.certBase64,
    idpEntityId: IDP_ENTITY_ID,
    audience: SP_ENTITY_ID,
    recipient: ACS_URL,
    nameId: 'user-ext-1',
    email: 'alice@acme.test',
    displayName: 'Alice Example',
    groups: ['Engineering', 'Admins'],
    inResponseTo: requestId,
    ...overrides,
  })
  return { samlResponse, assertionId, requestId }
}

describe('SAML validation — valid assertion', () => {
  it('extracts externalId, email, displayName and groups from a valid signed assertion', async () => {
    const { samlResponse, requestId } = baseResponse()
    const saml = await makeSaml(requestId)
    const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse })
    expect(profile).not.toBeNull()
    expect(profile?.nameID).toBe('user-ext-1')
    // email surfaces under the standard claim URI.
    const email =
      profile?.email ??
      profile?.['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress']
    expect(email).toBe('alice@acme.test')
    const groups =
      profile?.groups ?? (profile as Record<string, unknown> | null | undefined)?.groups
    expect(groups).toEqual(['Engineering', 'Admins'])
  })
})

describe('SAML validation — security rejections', () => {
  it('rejects a tampered assertion (bad signature)', async () => {
    const { samlResponse, requestId } = baseResponse()
    // Tamper the decoded XML after signing, then re-encode — invalidates the digest.
    const xml = Buffer.from(samlResponse, 'base64').toString('utf8')
    const tampered = xml.replace('alice@acme.test', 'attacker@evil.test')
    const tamperedB64 = Buffer.from(tampered, 'utf8').toString('base64')

    const saml = await makeSaml(requestId)
    await expect(saml.validatePostResponseAsync({ SAMLResponse: tamperedB64 })).rejects.toThrow(
      /Invalid signature/i,
    )
  })

  it('rejects when signed with a different cert than configured idpCert', async () => {
    const otherKm = generateIdpKeyMaterial()
    const requestId = `_req_${Math.random().toString(36).slice(2)}`
    const { samlResponse } = buildSignedSamlResponse({
      privateKey: otherKm.privateKey,
      certBase64: otherKm.certBase64,
      idpEntityId: IDP_ENTITY_ID,
      audience: SP_ENTITY_ID,
      recipient: ACS_URL,
      nameId: 'user-ext-1',
      email: 'alice@acme.test',
      inResponseTo: requestId,
    })
    // `saml` is configured with km.certBase64, not otherKm — signature must fail.
    const saml = await makeSaml(requestId)
    await expect(saml.validatePostResponseAsync({ SAMLResponse: samlResponse })).rejects.toThrow(
      /Invalid signature/i,
    )
  })

  it('rejects an audience mismatch (assertion bound to a different SP entityId)', async () => {
    const { samlResponse, requestId } = baseResponse({ audience: 'https://wrong-sp.test/entity' })
    const saml = await makeSaml(requestId)
    await expect(saml.validatePostResponseAsync({ SAMLResponse: samlResponse })).rejects.toThrow(
      /audience/i,
    )
  })

  it('rejects expired conditions (NotOnOrAfter in the past)', async () => {
    const { samlResponse, requestId } = baseResponse({
      notBefore: new Date(Date.now() - 20 * 60_000),
      notOnOrAfter: new Date(Date.now() - 10 * 60_000),
    })
    const saml = await makeSaml(requestId)
    await expect(saml.validatePostResponseAsync({ SAMLResponse: samlResponse })).rejects.toThrow()
  })
})

describe('SAML replay protection — assertAssertionNotReplayed', () => {
  it('throws on the second use of the same assertion ID within its validity window', () => {
    const assertionId = `_replay_${Math.random().toString(36).slice(2)}`
    const notOnOrAfter = new Date(Date.now() + 5 * 60_000)
    // First use records the ID.
    expect(() => assertAssertionNotReplayed(assertionId, notOnOrAfter)).not.toThrow()
    // Second use within the window is a replay.
    expect(() => assertAssertionNotReplayed(assertionId, notOnOrAfter)).toThrow(/replay/i)
  })

  it('allows a fresh assertion ID', () => {
    const a = `_a_${Math.random().toString(36).slice(2)}`
    const b = `_b_${Math.random().toString(36).slice(2)}`
    const exp = new Date(Date.now() + 5 * 60_000)
    expect(() => assertAssertionNotReplayed(a, exp)).not.toThrow()
    expect(() => assertAssertionNotReplayed(b, exp)).not.toThrow()
  })

  it('re-permits an ID once its validity window has elapsed (lazy eviction)', () => {
    const id = `_exp_${Math.random().toString(36).slice(2)}`
    // Already-expired window → recorded entry is immediately evictable.
    expect(() => assertAssertionNotReplayed(id, new Date(Date.now() - 1000))).not.toThrow()
    // Next call evicts the expired entry first, so the same ID is allowed again.
    expect(() => assertAssertionNotReplayed(id, new Date(Date.now() + 5 * 60_000))).not.toThrow()
  })
})

describe('production validateSamlResponse — InResponseTo CSRF guard', () => {
  it('rejects an IdP-initiated response with no correlated InResponseTo', async () => {
    // No `inResponseTo` → production config uses validateInResponseTo: "always",
    // so an unsolicited response is rejected before any profile is returned.
    const { samlResponse } = buildSignedSamlResponse({
      privateKey: km.privateKey,
      certBase64: km.certBase64,
      idpEntityId: IDP_ENTITY_ID,
      audience: SP_ENTITY_ID,
      recipient: ACS_URL,
      nameId: 'user-ext-1',
      email: 'alice@acme.test',
    })
    await expect(
      validateSamlResponse({
        idpEntityId: IDP_ENTITY_ID,
        idpSsoUrl: IDP_SSO_URL,
        idpCert: km.certBase64,
        spEntityId: SP_ENTITY_ID,
        callbackUrl: ACS_URL,
        wantAssertionsSigned: true,
        samlResponseBody: { SAMLResponse: samlResponse },
      }),
    ).rejects.toThrow(/InResponseTo/i)
  })
})
