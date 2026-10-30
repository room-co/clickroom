/**
 * In-test SAML response fixture builder.
 *
 * Generates a self-signed RSA cert/key (in-memory, no fixtures on disk), builds a
 * minimal but spec-shaped SAML 2.0 Response containing a single signed Assertion,
 * and base64-encodes it the way an IdP POSTs it to the ACS endpoint.
 *
 * The assertion is signed with `xml-crypto` using an enveloped-signature transform
 * and exclusive C14N — the same shape `@node-saml/node-saml` validates against the
 * configured `idpCert`. This lets the SAML validation tests exercise the real
 * library code path (signature, audience, expiry) rather than mocks.
 */
import { createRequire } from 'node:module'
import { SignedXml } from 'xml-crypto'

// `node-forge` ships no bundled types and we use only a tiny slice of its API to
// mint a self-signed cert. Load it via createRequire with a narrow local type so
// the test suite typechecks without pulling in @types/node-forge.
interface ForgePki {
  rsa: { generateKeyPair: (bits: number) => { publicKey: unknown; privateKey: unknown } }
  createCertificate: () => {
    publicKey: unknown
    serialNumber: string
    validity: { notBefore: Date; notAfter: Date }
    setSubject: (attrs: Array<{ name: string; value: string }>) => void
    setIssuer: (attrs: Array<{ name: string; value: string }>) => void
    sign: (key: unknown, md: unknown) => void
  }
  certificateToPem: (cert: unknown) => string
  privateKeyToPem: (key: unknown) => string
}
interface Forge {
  pki: ForgePki
  md: { sha256: { create: () => unknown } }
}
const forge = createRequire(import.meta.url)('node-forge') as Forge

export interface SamlIdpKeyMaterial {
  /** PEM private key used to sign the assertion. */
  privateKey: string
  /** PEM certificate the SP (node-saml) validates the signature against. */
  certPem: string
  /** The bare base64 cert body (no PEM header/footer), for node-saml `idpCert`. */
  certBase64: string
}

/**
 * Mint a self-signed X.509 certificate + RSA private key purely in memory using
 * `node-forge`. node-saml extracts the public key from this cert (via Node's
 * `crypto.createVerify().verify(certPem, ...)`) to validate the assertion
 * signature, so a real cert — not a bare public key — is required.
 */
export function generateIdpKeyMaterial(): SamlIdpKeyMaterial {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000)
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  const attrs = [{ name: 'commonName', value: 'clickroom-test-idp' }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())

  const certPem = forge.pki.certificateToPem(cert)
  const privateKey = forge.pki.privateKeyToPem(keys.privateKey)
  const certBase64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----/, '')
    .replace(/-----END CERTIFICATE-----/, '')
    .replace(/\s+/g, '')
  return { privateKey, certPem, certBase64 }
}

export interface BuildSamlResponseInput {
  privateKey: string
  certBase64: string
  idpEntityId: string
  /** SP entityId — goes into <AudienceRestriction>. */
  audience: string
  /** ACS URL — goes into <SubjectConfirmationData Recipient>. */
  recipient: string
  nameId: string
  email: string
  displayName?: string
  groups?: string[]
  /** Assertion ID. Reused to test replay. */
  assertionId?: string
  /** Conditions NotOnOrAfter. Set in the past to test expiry. */
  notOnOrAfter?: Date
  notBefore?: Date
  /** Correlated AuthnRequest ID — set as Response/@InResponseTo. */
  inResponseTo?: string
}

function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Build an *unsigned* SAML assertion XML string (no Response envelope yet).
 */
function buildAssertionXml(input: BuildSamlResponseInput): { xml: string; assertionId: string } {
  const now = new Date()
  const assertionId = input.assertionId ?? `_assert_${Math.random().toString(36).slice(2)}`
  const issueInstant = iso(now)
  const notBefore = iso(input.notBefore ?? new Date(now.getTime() - 60_000))
  const notOnOrAfter = iso(input.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000))
  const displayName = input.displayName ?? input.email

  const groupAttr =
    input.groups && input.groups.length > 0
      ? `<saml:Attribute Name="groups" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">${input.groups
          .map(
            (g) =>
              `<saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${g}</saml:AttributeValue>`,
          )
          .join('')}</saml:Attribute>`
      : ''

  const xml = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" Version="2.0" ID="${assertionId}" IssueInstant="${issueInstant}"><saml:Issuer>${input.idpEntityId}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${input.nameId}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${input.recipient}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${input.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="${assertionId}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic"><saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${input.email}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic"><saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${displayName}</saml:AttributeValue></saml:Attribute>${groupAttr}</saml:AttributeStatement></saml:Assertion>`

  return { xml, assertionId }
}

/**
 * Sign the assertion (enveloped) and wrap it in a Response envelope, then
 * base64-encode for the `SAMLResponse` form field.
 */
export function buildSignedSamlResponse(input: BuildSamlResponseInput): {
  samlResponse: string
  assertionId: string
} {
  const { xml: assertionXml, assertionId } = buildAssertionXml(input)

  const sig = new SignedXml({
    privateKey: input.privateKey,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    publicCert: `-----BEGIN CERTIFICATE-----\n${input.certBase64}\n-----END CERTIFICATE-----`,
  })
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    uri: `#${assertionId}`,
    isEmptyUri: false,
  })
  // KeyInfo carries the X509 cert so node-saml can locate the signing cert.
  sig.getKeyInfoContent = SignedXml.getKeyInfoContent

  sig.computeSignature(assertionXml, {
    location: { reference: "//*[local-name(.)='Issuer']", action: 'after' },
  })
  const signedAssertion = sig.getSignedXml()

  const responseId = `_resp_${Math.random().toString(36).slice(2)}`
  const issueInstant = iso(new Date())
  const inResponseToAttr = input.inResponseTo != null ? ` InResponseTo="${input.inResponseTo}"` : ''
  const responseXml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" Version="2.0" ID="${responseId}"${inResponseToAttr} IssueInstant="${issueInstant}" Destination="${input.recipient}"><saml:Issuer>${input.idpEntityId}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signedAssertion}</samlp:Response>`

  return { samlResponse: Buffer.from(responseXml, 'utf8').toString('base64'), assertionId }
}
