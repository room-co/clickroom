// SSO admin config. zod input schemas for sso.router.ts.
// Mirrors the reference implementation's apps/api/src/trpc/routers/sso.router.ts input shapes, minus
// the `team`/`team_role` half of group-mapping — Clickroom's `SsoMappingTarget`
// enum has only the `org_role` variant (see packages/db/prisma/schema.prisma).
import { z } from 'zod'

export const orgRoleSchema = z.enum(['org_admin', 'member', 'viewer'])

export const ssoProtocolSchema = z.enum(['saml', 'oidc'])

export const upsertConnectionSchema = z.object({
  protocol: ssoProtocolSchema,
  displayName: z.string().min(1).max(200),
  defaultOrgRole: orgRoleSchema.default('member'),
  attributeMapping: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  // OIDC
  oidcIssuerUrl: z.string().url().nullish(),
  oidcClientId: z.string().nullish(),
  oidcClientSecret: z.string().nullish(),
  // SAML
  samlIdpEntityId: z.string().nullish(),
  samlIdpSsoUrl: z.string().url().nullish(),
  samlIdpX509Cert: z.string().nullish(),
  samlSpEntityId: z.string().nullish(),
  samlWantAssertionsSigned: z.boolean().optional(),
  // Secret — only re-sealed when a non-empty value is supplied.
  spPrivateKey: z.string().nullish(),
})

export const setEnforcedSchema = z.object({ enforced: z.boolean() })

export const addDomainSchema = z.object({ domain: z.string().min(1).max(253) })

export const domainIdSchema = z.object({ domainId: z.string().min(1) })

export const connectionIdSchema = z.object({ connectionId: z.string().min(1) })

// Group mappings are org_role-only (no `team` target exists in Clickroom's
// SsoMappingTarget enum), so — unlike the reference implementation's discriminated-union-by-`target`
// shape — this is a flat object. `idpGroup` non-empty is enforced by `.min(1)`
// directly; a `superRefine` isn't needed since there's no conditional branch
// left once the team half is dropped.
export const upsertGroupMappingSchema = z.object({
  connectionId: z.string().min(1),
  idpGroup: z.string().min(1).max(200),
  orgRole: orgRoleSchema,
})

export const deleteGroupMappingSchema = z.object({
  connectionId: z.string().min(1),
  mappingId: z.string().min(1),
})
