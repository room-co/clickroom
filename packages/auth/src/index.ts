// @clickroom/auth — Argon2id + JWT auth, API keys, RBAC permissions.

export type {
  Admin2faChallengePayload,
  AdminAccessTokenPayload,
  AdminRefreshTokenPayload,
} from './admin-tokens.js'
export {
  ADMIN_2FA_CHALLENGE_TTL_SECONDS,
  ADMIN_ACCESS_TOKEN_TTL_SECONDS,
  ADMIN_REFRESH_TOKEN_COOKIE,
  ADMIN_REFRESH_TOKEN_TTL_SECONDS,
  generateAdminRefreshJti,
  signAdmin2faChallenge,
  signAdminAccessToken,
  signAdminRefreshToken,
  verifyAdmin2faChallenge,
  verifyAdminAccessToken,
  verifyAdminRefreshToken,
} from './admin-tokens.js'
export type { ApiKeyType } from './apikey.js'
export {
  API_KEY_PREFIX_LENGTH,
  apiKeyTypePrefix,
  generateApiKey,
  hashApiKey,
  parseMcpApiKey,
} from './apikey.js'
export {
  DEV_ADMIN_JWT_SECRET,
  DEV_JWT_SECRET,
  DEV_MCP_OAUTH_STATE_SECRET,
  DEV_SSO_RELAY_STATE_SECRET,
  isDevLikeEnv,
  resolveSecret,
} from './dev-secret.js'
export { hashPassword, verifyPassword } from './password.js'
export type { OrgRole, Permission } from './permissions.js'
export { assertCan, can, ROLE_PERMISSIONS } from './permissions.js'
export { openJson, sealJson } from './secrets.js'
export type {
  AccessTokenPayload,
  McpAccessTokenPayload,
  McpConsentTicketPayload,
} from './tokens.js'
export {
  ACCESS_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
  issueAccessToken,
  issueMcpAccessToken,
  issueMcpConsentTicket,
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  MCP_CONSENT_TICKET_TTL_SECONDS,
  MCP_REFRESH_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_TTL_SECONDS,
  refreshTokenExpiresAt,
  refreshTokenSelector,
  verifyAccessToken,
  verifyMcpAccessToken,
  verifyMcpConsentTicket,
  verifyRefreshToken,
} from './tokens.js'
export {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  totpCodeForStep,
  totpStep,
  verifyTotp,
} from './totp.js'
