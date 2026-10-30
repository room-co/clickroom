import { randomUUID } from 'node:crypto'
import { type Profile, SAML, type SamlConfig } from '@node-saml/node-saml'

/**
 * Pure SAML helper functions for the SP-initiated SSO flow.
 *
 * No DB access: every function takes the resolved connection config as input.
 * The `node-saml` SAML class is constructed per-call from these options — it is
 * cheap to instantiate and keeps the helpers stateless (aside from the in-memory
 * replay cache below, which is intentionally process-global single-use state).
 *
 * Library surface used (confirmed against @node-saml/node-saml@5.1.0):
 *   - class `SAML` (constructor: `new SAML(SamlConfig)`)
 *   - `saml.getAuthorizeUrlAsync(RelayState, host, AuthOptions): Promise<string>`
 *   - `saml.validatePostResponseAsync({ SAMLResponse, RelayState }): Promise<{ profile, loggedOut }>`
 *   - `saml.generateServiceProviderMetadata(decryptionCert, publicCerts): string`
 *
 * Option keys used: `idpCert`, `issuer`, `callbackUrl`, `entryPoint`, `idpIssuer`,
 * `audience`, `wantAssertionsSigned`, `wantAuthnResponseSigned`,
 * `validateInResponseTo`, `identifierFormat`.
 */

/** Common Entra ID / ADFS / Okta claim URIs for the email address. */
const EMAIL_CLAIM_URIS = [
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
  'urn:oid:0.9.2342.19200300.100.1.3',
] as const

/** Common claim URIs for a human-readable display name. */
const DISPLAY_NAME_CLAIM_URIS = [
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/displayname',
  'urn:oid:2.16.840.1.113730.3.1.241',
  'displayName',
  'name',
] as const

/** Default attribute names that carry IdP group membership. */
const DEFAULT_GROUP_CLAIM_URIS = [
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
  'http://schemas.xmlsoap.org/claims/Group',
  'groups',
  'memberOf',
] as const

export interface SamlConnectionOptions {
  idpEntityId: string
  idpSsoUrl: string
  idpCert: string
  spEntityId: string
  callbackUrl: string
  wantAssertionsSigned: boolean
  /** Optional override for the attribute that carries group membership. */
  groupsAttribute?: string
}

/**
 * Build the `node-saml` config from a connection. We set `issuer = spEntityId`
 * (our SP entityID, echoed back to the IdP) and `audience = spEntityId` so that
 * node-saml enforces the assertion's `<AudienceRestriction>` matches us.
 *
 * `idpIssuer = idpEntityId` makes node-saml verify the response `<Issuer>` is the
 * expected IdP. `validateInResponseTo = 'always'` makes node-saml track the
 * generated request ID in its internal cache and reject responses whose
 * `InResponseTo` was not issued by us (anti-replay / CSRF at the protocol level).
 * We additionally rely on a signed-cookie relay state for CSRF in the controller.
 */
function buildSamlConfig(opts: SamlConnectionOptions): SamlConfig {
  return {
    idpCert: opts.idpCert,
    issuer: opts.spEntityId,
    callbackUrl: opts.callbackUrl,
    entryPoint: opts.idpSsoUrl,
    idpIssuer: opts.idpEntityId,
    audience: opts.spEntityId,
    wantAssertionsSigned: opts.wantAssertionsSigned,
    // Require the top-level Response signature too — defends against assertion
    // wrapping when the IdP signs the response envelope.
    wantAuthnResponseSigned: false,
    validateInResponseTo:
      // 'always' — node-saml stores each generated request ID and rejects any
      // response not correlated to one we issued.
      'always' as SamlConfig['validateInResponseTo'],
    identifierFormat: null,
  }
}

export interface SamlAuthRequest {
  redirectUrl: string
  relayState?: string
}

/**
 * Construct the IdP redirect URL for an SP-initiated AuthnRequest.
 *
 * A fresh RelayState (opaque UUID) is generated and returned so the caller can
 * bind it into a signed cookie for CSRF protection; node-saml echoes it through
 * the IdP and it comes back on the ACS POST.
 *
 * node-saml validates `InResponseTo` internally via its request-ID cache (the
 * request ID generated here is stored by the SAML instance); we additionally
 * rely on the signed-cookie relay state for CSRF. Note: because each call
 * constructs a fresh SAML instance with the default in-memory cache, the
 * InResponseTo cache does not survive a process restart — the signed relay-state
 * cookie is the durable CSRF guard.
 */
export async function buildSamlAuthRequest(opts: SamlConnectionOptions): Promise<SamlAuthRequest> {
  const saml = new SAML(buildSamlConfig(opts))
  const relayState = randomUUID()
  const redirectUrl = await saml.getAuthorizeUrlAsync(relayState, undefined, {})
  return { redirectUrl, relayState }
}

export interface SamlAssertionResult {
  externalId: string
  email: string
  fullName: string
  groups: string[]
}

export interface ValidateSamlResponseOptions extends SamlConnectionOptions {
  samlResponseBody: { SAMLResponse: string; RelayState?: string }
}

/**
 * Validate a SAML POST response (the ACS callback) and extract the user profile.
 *
 * node-saml's `validatePostResponseAsync` enforces, given the config above:
 *   - XML signature against `idpCert`,
 *   - audience == `spEntityId` (via the `audience` option),
 *   - `Conditions`/`SubjectConfirmationData` NotBefore / NotOnOrAfter window,
 *   - `InResponseTo` correlation (via `validateInResponseTo: 'always'`),
 *   - issuer == `idpEntityId` (via `idpIssuer`).
 *
 * On top of that we enforce single-use of the assertion via `assertAssertionNotReplayed`.
 */
export async function validateSamlResponse(
  opts: ValidateSamlResponseOptions,
): Promise<SamlAssertionResult> {
  const saml = new SAML(buildSamlConfig(opts))
  const { profile } = await saml.validatePostResponseAsync({
    SAMLResponse: opts.samlResponseBody.SAMLResponse,
    ...(opts.samlResponseBody.RelayState !== undefined
      ? { RelayState: opts.samlResponseBody.RelayState }
      : {}),
  })

  if (profile == null) {
    throw new Error('SAML response did not contain an assertion profile')
  }

  // Replay protection — single-use assertion ID. node-saml does not surface the
  // assertion ID on the profile (profile.ID is only populated for logout
  // requests), so we parse it from the assertion XML (see getAssertionId).
  const assertionXml = profile.getAssertionXml?.()
  if (assertionXml != null) {
    const assertionId = getAssertionId(assertionXml)
    const notOnOrAfter = getAssertionNotOnOrAfter(assertionXml)
    if (assertionId != null) {
      assertAssertionNotReplayed(assertionId, notOnOrAfter)
    }
  }

  return mapProfile(profile, opts.groupsAttribute)
}

function mapProfile(profile: Profile, groupsAttribute?: string): SamlAssertionResult {
  const externalId = profile.nameID
  if (!externalId) {
    throw new Error('SAML assertion is missing a NameID')
  }

  const email =
    firstString(profile.email, profile.mail, ...EMAIL_CLAIM_URIS.map((uri) => profile[uri])) ??
    externalId

  const fullName = firstString(...DISPLAY_NAME_CLAIM_URIS.map((uri) => profile[uri])) ?? email

  const groupKeys = groupsAttribute ? [groupsAttribute] : [...DEFAULT_GROUP_CLAIM_URIS]
  const groups = normalizeGroups(groupKeys.map((key) => profile[key]).find((v) => v != null))

  return { externalId, email, fullName, groups }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** node-saml may return a group attribute as a single string or a string[]. */
function normalizeGroups(value: unknown): string[] {
  if (value == null) return []
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
  }
  if (typeof value === 'string' && value.length > 0) return [value]
  return []
}

/**
 * Extract the `ID` attribute of the `<...:Assertion>` element from the signed
 * assertion XML returned by `profile.getAssertionXml()`. The assertion ID is a
 * unique per-assertion identifier and is the correct anti-replay key.
 *
 * We use a regex on the (already signature-validated) assertion XML rather than a
 * full XML parse: node-saml only validates the signature, not a strongly-typed
 * accessor for the ID, and the XML has already passed signature verification at
 * this point so it is trusted.
 */
function getAssertionId(assertionXml: string): string | undefined {
  const match = assertionXml.match(/<(?:[\w-]+:)?Assertion\b[^>]*\bID\s*=\s*["']([^"']+)["']/i)
  return match?.[1]
}

/**
 * Extract the most restrictive `NotOnOrAfter` from the assertion XML to bound how
 * long the replay cache must retain the ID. Falls back to a short default window
 * when none is present.
 */
function getAssertionNotOnOrAfter(assertionXml: string): Date {
  const matches = [...assertionXml.matchAll(/NotOnOrAfter\s*=\s*["']([^"']+)["']/gi)]
  let earliest: Date | undefined
  for (const m of matches) {
    const raw = m[1]
    if (raw == null) continue
    const d = new Date(raw)
    if (!Number.isNaN(d.getTime()) && (earliest == null || d < earliest)) {
      earliest = d
    }
  }
  // Default: keep the ID for 10 minutes if the assertion has no expiry.
  return earliest ?? new Date(Date.now() + 10 * 60 * 1000)
}

export interface GenerateSamlMetadataOptions {
  spEntityId: string
  callbackUrl: string
  spSigningCert?: string
  wantAssertionsSigned: boolean
}

/**
 * Generate SP metadata XML (entityID + ACS URL on the HTTP-POST binding) for the
 * IdP-side configuration. Uses node-saml's `generateServiceProviderMetadata`,
 * which renders the ACS URL from `callbackUrl` with `Binding=HTTP-POST`.
 */
export function generateSamlMetadata(opts: GenerateSamlMetadataOptions): string {
  const saml = new SAML({
    // Metadata generation does not validate an IdP cert; a placeholder satisfies
    // the mandatory option and never appears in the output.
    idpCert: '-----BEGIN CERTIFICATE-----\nMETADATA\n-----END CERTIFICATE-----',
    issuer: opts.spEntityId,
    callbackUrl: opts.callbackUrl,
    wantAssertionsSigned: opts.wantAssertionsSigned,
    identifierFormat: null,
  })
  // `decryptionCert` = null (no SP-side decryption cert advertised);
  // `publicCerts` = the SP signing cert (if any) advertised in <KeyDescriptor>.
  return saml.generateServiceProviderMetadata(null, opts.spSigningCert ?? null)
}

// ---------------------------------------------------------------------------
// Replay protection — in-memory single-use assertion-ID cache.
// ---------------------------------------------------------------------------

/** Map of assertion ID -> expiry epoch ms. Expired entries are evicted lazily. */
const seenAssertions = new Map<string, number>()

/** Evict every entry whose expiry is in the past. */
function evictExpired(nowMs: number): void {
  for (const [id, expiry] of seenAssertions) {
    if (expiry <= nowMs) seenAssertions.delete(id)
  }
}

/**
 * Throw if `assertionId` has already been seen (within its validity window),
 * otherwise record it as used until `notOnOrAfter`.
 *
 * This is a single-process guard. In a multi-instance deployment a shared store
 * (e.g. the DB or Redis) would be required for cluster-wide replay protection;
 * the durable InResponseTo + signed relay-state cookie still apply per request.
 */
export function assertAssertionNotReplayed(assertionId: string, notOnOrAfter: Date): void {
  const nowMs = Date.now()
  evictExpired(nowMs)

  const existing = seenAssertions.get(assertionId)
  if (existing != null && existing > nowMs) {
    throw new Error('SAML assertion replay detected')
  }

  const expiry = notOnOrAfter.getTime()
  seenAssertions.set(assertionId, Number.isNaN(expiry) ? nowMs + 10 * 60 * 1000 : expiry)
}
