// SSO admin config tRPC router. Ported from the reference implementation's
// apps/api/src/trpc/routers/sso.router.ts, adapted to Clickroom's shape:
//   - No `sso-enabled` flag / `feature:sso` entitlement gate:
//     `requirePermission('org:update')` is the only gate.
//   - Group mappings are org_role-only (no `team` target — see sso.schema.ts).
//   - `ctx.db` (org-scoped Prisma client from trpc.ts) replaces the reference implementation's
//     `ctx.prisma`; `SsoConnection`/`OrgDomain` are auto-scoped to `ctx.orgId`
//     by `createScopedClient` (packages/db/src/scoped-client.ts), so services
//     constructed with `ctx.db` never need an explicit orgId `where`.
//     `SsoGroupMapping` has no `orgId` column (only `ssoConnectionId`), so it
//     is NOT auto-scoped — every group-mapping procedure below goes through
//     `assertConnectionInOrg` first to prevent cross-org tampering via a
//     connection ID that belongs to a different org.
import {
  OrgDomainService,
  type ScopedPrismaClient,
  SsoConnectionService,
  SsoGroupMappingService,
} from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { generateSamlMetadata } from '../../http/sso/saml.js'
import { mcpOAuthIssuer } from '../../mcp/oauth/mcp-oauth.constants.js'
import { requirePermission, router } from '../trpc.js'
import {
  addDomainSchema,
  connectionIdSchema,
  deleteGroupMappingSchema,
  domainIdSchema,
  setEnforcedSchema,
  upsertConnectionSchema,
  upsertGroupMappingSchema,
} from './sso.schema.js'

/**
 * Load the caller's org connection and assert its id matches `connectionId`.
 * Prevents cross-org tampering on connection-scoped mutations/reads (domain
 * and group-mapping procedures are keyed by connectionId/domainId, not
 * orgId) — a caller who guesses or reuses another org's id gets NOT_FOUND
 * rather than touching that org's row.
 */
async function assertConnectionInOrg(
  db: ScopedPrismaClient,
  connectionId: string,
  orgId: string,
): Promise<void> {
  const connection = await new SsoConnectionService(db).getByOrg(orgId)
  if (!connection || connection.id !== connectionId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'SSO connection not found.' })
  }
}

/** Same NOT_FOUND-on-cross-org-id guard as {@link assertConnectionInOrg}, for domains. */
async function assertDomainInOrg(
  db: ScopedPrismaClient,
  domainId: string,
  orgId: string,
): Promise<void> {
  const domains = await new OrgDomainService(db).list(orgId)
  if (!domains.some((d) => d.id === domainId)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Domain not found.' })
  }
}

export const ssoRouter = router({
  // ---- Connection --------------------------------------------------------
  getConnection: requirePermission('org:update').query(({ ctx }) =>
    new SsoConnectionService(ctx.db).getByOrg(ctx.orgId),
  ),

  upsertConnection: requirePermission('org:update')
    .input(upsertConnectionSchema)
    .mutation(({ input, ctx }) =>
      new SsoConnectionService(ctx.db).upsert(ctx.orgId, {
        protocol: input.protocol,
        displayName: input.displayName,
        enabled: input.enabled,
        defaultOrgRole: input.defaultOrgRole,
        attributeMapping: input.attributeMapping,
        oidcIssuerUrl: input.oidcIssuerUrl,
        oidcClientId: input.oidcClientId,
        samlIdpEntityId: input.samlIdpEntityId,
        samlIdpSsoUrl: input.samlIdpSsoUrl,
        samlIdpX509Cert: input.samlIdpX509Cert,
        samlSpEntityId: input.samlSpEntityId,
        samlWantAssertionsSigned: input.samlWantAssertionsSigned,
        // Secrets are only re-sealed when a non-empty value is supplied —
        // see SsoConnectionService.upsert's merge logic.
        ...(input.oidcClientSecret ? { clientSecret: input.oidcClientSecret } : {}),
        ...(input.spPrivateKey ? { spPrivateKey: input.spPrivateKey } : {}),
      }),
    ),

  deleteConnection: requirePermission('org:update').mutation(async ({ ctx }) => {
    await new SsoConnectionService(ctx.db).delete(ctx.orgId)
    return { ok: true }
  }),

  setEnforced: requirePermission('org:update')
    .input(setEnforcedSchema)
    .mutation(({ input, ctx }) =>
      new SsoConnectionService(ctx.db).setEnforced(ctx.orgId, input.enforced),
    ),

  // ---- Domains ------------------------------------------------------------
  addDomain: requirePermission('org:update')
    .input(addDomainSchema)
    .mutation(async ({ input, ctx }) => {
      const record = await new OrgDomainService(ctx.db).add(ctx.orgId, input.domain)
      return {
        domain: record.domain,
        verificationToken: record.verificationToken,
        txtRecordName: `_clickroom-verify.${record.domain}`,
      }
    }),

  verifyDomain: requirePermission('org:update')
    .input(domainIdSchema)
    .mutation(async ({ input, ctx }) => {
      await assertDomainInOrg(ctx.db, input.domainId, ctx.orgId)
      return new OrgDomainService(ctx.db).verifyDomain(input.domainId)
    }),

  listDomains: requirePermission('org:update').query(({ ctx }) =>
    new OrgDomainService(ctx.db).list(ctx.orgId),
  ),

  removeDomain: requirePermission('org:update')
    .input(domainIdSchema)
    .mutation(async ({ input, ctx }) => {
      await assertDomainInOrg(ctx.db, input.domainId, ctx.orgId)
      await new OrgDomainService(ctx.db).remove(input.domainId)
      return { ok: true }
    }),

  // ---- Group mappings -------------------------------------------------------
  listGroupMappings: requirePermission('org:update')
    .input(connectionIdSchema)
    .query(async ({ input, ctx }) => {
      await assertConnectionInOrg(ctx.db, input.connectionId, ctx.orgId)
      return new SsoGroupMappingService(ctx.db).list(input.connectionId)
    }),

  upsertGroupMapping: requirePermission('org:update')
    .input(upsertGroupMappingSchema)
    .mutation(async ({ input, ctx }) => {
      await assertConnectionInOrg(ctx.db, input.connectionId, ctx.orgId)
      return new SsoGroupMappingService(ctx.db).upsert(input.connectionId, {
        idpGroup: input.idpGroup,
        orgRole: input.orgRole,
      })
    }),

  deleteGroupMapping: requirePermission('org:update')
    .input(deleteGroupMappingSchema)
    .mutation(async ({ input, ctx }) => {
      await assertConnectionInOrg(ctx.db, input.connectionId, ctx.orgId)
      await new SsoGroupMappingService(ctx.db).delete(input.mappingId, input.connectionId)
      return { ok: true }
    }),

  // ---- SP metadata (for the IdP-side config) -------------------------------
  getSpMetadata: requirePermission('org:update').query(async ({ ctx }) => {
    const connection = await new SsoConnectionService(ctx.db).getByOrg(ctx.orgId)
    if (!connection) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No SSO connection configured.' })
    }
    const apiBase = mcpOAuthIssuer()
    const callbackUrl = `${apiBase}/auth/sso/${connection.id}/callback`
    const acsUrl = `${apiBase}/auth/sso/${connection.id}/acs`
    const spEntityId = connection.samlSpEntityId ?? `${apiBase}/auth/sso/${connection.id}`
    const metadataUrl = `${apiBase}/auth/sso/${connection.id}/metadata`
    const metadataXml = generateSamlMetadata({
      spEntityId,
      callbackUrl: acsUrl,
      wantAssertionsSigned: connection.samlWantAssertionsSigned,
    })
    return {
      protocol: connection.protocol,
      callbackUrl,
      acsUrl,
      spEntityId,
      metadataUrl,
      metadataXml,
    }
  }),
})
