import { PutParameterCommand, SSMClient, type SSMClientConfig } from '@aws-sdk/client-ssm'

let cached: SSMClient | undefined

// Build SSM config from raw process.env — deliberately bypassing any dev-only credential
// substitution used elsewhere for LocalStack. SSM operations must hit real AWS, so let the
// default credential chain resolve unless real keys are present.
function buildSsmConfig(): SSMClientConfig {
  const cfg: SSMClientConfig = { region: process.env.AWS_REGION ?? 'us-east-1' }
  if (process.env.AWS_SSM_ENDPOINT_URL) cfg.endpoint = process.env.AWS_SSM_ENDPOINT_URL
  const key = process.env.AWS_ACCESS_KEY_ID
  const secret = process.env.AWS_SECRET_ACCESS_KEY
  // Only forward explicit credentials. 'test' is the LocalStack placeholder and would
  // otherwise short-circuit the default credential chain (AWS_PROFILE / SSO / instance role).
  if (key && secret && key !== 'test') {
    cfg.credentials = { accessKeyId: key, secretAccessKey: secret }
  }
  return cfg
}

function getClient(): SSMClient {
  if (!cached) cached = new SSMClient(buildSsmConfig())
  return cached
}

// SSM parameter names only accept letters, digits and `.`, `-`, `_` within a path segment —
// an email's `@` (and anything else exotic) would make PutParameter throw ValidationException.
function toParameterSegment(email: string): string {
  return email.toLowerCase().replace(/[^a-z0-9.\-_]/g, '_')
}

export function adminPasswordParameterName(email: string): string {
  return `/clickroom/admin/users/${toParameterSegment(email)}/password`
}

export async function putAdminPasswordParameter(email: string, password: string): Promise<string> {
  const Name = adminPasswordParameterName(email)
  await getClient().send(
    new PutParameterCommand({
      Name,
      Value: password,
      Type: 'SecureString',
      Overwrite: true,
    }),
  )
  return Name
}
