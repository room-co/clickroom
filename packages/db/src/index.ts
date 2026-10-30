// @clickroom/db — Prisma schema + client (Postgres config store).
export {
  type Environment,
  FlagAuditAction,
  OrgRole,
  Prisma,
  PrismaClient,
} from '@prisma/client'
export {
  ACTIONS_BY_CATEGORY,
  type AuditCategory,
  classifyAuditAction,
} from './admin-audit/classify-audit-action.js'
export {
  type AdminAuditEntry,
  AdminAuditService,
  type RecordAuditInput,
} from './admin-audit.service.js'
export {
  type AdminProvisionIo,
  type AdminProvisionResult,
  choosePassword,
  deliverPassword,
  ensureBootstrapAdmin,
  provisionAdmin,
} from './admin-provision.js'
export {
  AdminRecoveryCodesService,
  formatRecoveryCode,
  normalizeRecoveryCode,
} from './admin-recovery-codes.service.js'
export { decryptTotpSecret, encryptTotpSecret } from './admin-totp-crypto.js'
export {
  type BootstrapOrgInput,
  type BootstrapOrgResult,
  backfillProjectEnvironments,
  backfillSystemDefinitions,
  bootstrapOrg,
  createDefaultEnvironments,
  seedSystemDefinitions,
  slugify,
  uniqueOrgSlug,
} from './bootstrap.js'
export { newId, prisma } from './client.js'
export {
  type AdminPasswordSink,
  type Deployment,
  isSelfHost,
  resolveAdminPasswordSink,
  resolveDeployment,
  resolveSignupMode,
  type SignupMode,
} from './deployment.js'
export {
  denyResult,
  type EntitlementResult,
  EntitlementService,
  resolveFeatures,
} from './entitlement.service.js'
export {
  canSelfEnableOverage,
  DEFAULT_PLAN_KEY,
  defaultPlanKey,
  type EffectiveLimits,
  effectiveLimits,
  type OrgLimitOverrides,
  type PlanLimits,
  SELF_HOST_PLAN_KEY,
} from './limits.js'
export {
  OrgDomainService,
  type ResolvedOrgByDomain,
  type VerifyDomainResult,
} from './org-domain.service.js'
export {
  allFeatures,
  ENFORCED_FEATURES,
  type EntitlementAction,
  FEATURE_BY_ACTION,
  featureKeys,
  isPlanKey,
  noFeatures,
  PLAN_FEATURES,
  type PlanFeatures,
  type PlanKey,
  UPGRADE_PATH,
} from './plan-registry.js'
export { type RequestContext, requestContextStorage } from './request-context.js'
export {
  createScopedClient,
  INTENTIONALLY_UNSCOPED,
  ORG_TENANT_MODELS,
  PROJECT_TENANT_MODELS,
  type ScopedPrismaClient,
  type TenantScope,
} from './scoped-client.js'
export { enforceSelfHostPlans } from './self-host-plans.js'
export {
  type SafeSsoConnection,
  type SsoConnectionSecrets,
  SsoConnectionService,
  type SsoConnectionWithSecrets,
  type UpsertSsoConnectionInput,
} from './sso-connection.service.js'
export {
  higherRole,
  type ResolvedMappings,
  resolveMappingsFromRows,
  SsoGroupMappingService,
  type UpsertGroupMappingInput,
} from './sso-group-mapping.service.js'
export { SsoIdentityService } from './sso-identity.service.js'
export {
  type ProvisionInput,
  type ProvisionResult,
  SsoProvisioningService,
} from './sso-provisioning.service.js'

export const PACKAGE_NAME = '@clickroom/db'
export { type ResetPasswordResult, resetUserPassword } from './user-reset-password.js'
