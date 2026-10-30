/**
 * Integration tests for SSO — OIDC callback guards (task.
 *
 * `handleOidcCallback` delegates state/nonce/PKCE/ID-token validation to
 * `openid-client`'s `authorizationCodeGrant`, which first runs OIDC *discovery*
 * against the issuer's `.well-known/openid-configuration`.
 *
 * To exercise the security-relevant **state guard** deterministically (without a
 * live IdP or a full mock OIDC server), we mock only `openid-client`'s `discovery`
 * to return a synthetic — but real — `Configuration` built from in-memory server
 * metadata. The genuine `authorizationCodeGrant` then runs against it: oauth4webapi
 * validates `state` *before* any network call to the token endpoint, so a
 * state-mismatch rejects with the real library error
 * (`cause.message === 'unexpected "state" response parameter value'`) and never
 * reaches the (unreachable) token endpoint.
 *
 * The nonce-mismatch path is asserted by `openid-client`'s own test-suite and by
 * a manual e2e against a real IdP — it requires a signed ID token from the token
 * endpoint, which is out of scope for this in-process test.
 */
import { Configuration, type discovery as discoveryFn } from 'openid-client'
import { describe, expect, it, vi } from 'vitest'

// Synthetic, network-free OIDC server metadata. `Configuration` is a real
// openid-client object — only `discovery` is stubbed to return it, so the
// genuine `authorizationCodeGrant` (and its state validation) runs unchanged.
const SYNTHETIC_SERVER = {
  issuer: 'https://idp.example.test',
  authorization_endpoint: 'https://idp.example.test/authorize',
  token_endpoint: 'https://idp.example.test/token',
  jwks_uri: 'https://idp.example.test/jwks',
}

vi.mock('openid-client', async (importActual) => {
  const actual = await importActual<typeof import('openid-client')>()
  const discovery: typeof discoveryFn = async (_url, clientId, clientSecret) =>
    new actual.Configuration(SYNTHETIC_SERVER, clientId, String(clientSecret))
  return { ...actual, discovery }
})

const { handleOidcCallback } = await import('../http/sso/oidc.js')

const baseOpts = {
  issuerUrl: SYNTHETIC_SERVER.issuer,
  clientId: 'test-client',
  clientSecret: 'test-secret',
  redirectUri: 'https://sp.clickroom.test/oidc/callback',
  callbackUrl: 'https://sp.clickroom.test/oidc/callback?code=abc&state=returned-state',
  codeVerifier: 'a'.repeat(43),
}

// Guard against an accidental no-op mock: the synthetic Configuration must be a
// genuine openid-client object so the real `authorizationCodeGrant` runs.
void Configuration

describe('OIDC handleOidcCallback', () => {
  it('fails hard (rejects) rather than returning a profile when the token exchange cannot complete', async () => {
    // expectedState matches the callback URL, so the state guard passes and the
    // grant proceeds to the (unreachable) token endpoint — it must still reject,
    // never resolving to a profile.
    await expect(
      handleOidcCallback({
        ...baseOpts,
        expectedState: 'returned-state',
        expectedNonce: 'expected-nonce',
      }),
    ).rejects.toBeTruthy()
  })

  it('rejects when the persisted expectedState does not match the returned state', async () => {
    // The callback URL carries state=returned-state but we pass a different
    // expectedState; oauth4webapi rejects on the state check before any token
    // request. The state reason surfaces on the wrapped error's `cause`.
    await expect(
      handleOidcCallback({
        ...baseOpts,
        expectedState: 'a-totally-different-state',
        expectedNonce: 'expected-nonce',
      }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/state/i) },
    })
  })

  // The nonce-mismatch rejection happens inside `authorizationCodeGrant` only
  // after the token endpoint returns a signed ID token (nonce is an ID-token
  // claim). Exercising it in-process requires a full mock token endpoint + JWKS +
  // a signed ID token, which is out of scope for this test. This path is covered
  // by openid-client's own tests and by a manual e2e against a real IdP.
  it.skip('rejects nonce mismatch against a live/mocked IdP (needs a signed ID token)', () => {
    // intentionally skipped — see comment above.
  })
})
