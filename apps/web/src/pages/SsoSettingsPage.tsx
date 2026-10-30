// SSO admin settings page. Ported from the reference implementation's
// apps/app/src/app/pages/SsoSettingsPage.tsx, adapted to Clickroom:
//   - No LaunchDarkly entitlement/`sso-enabled` flag gate — SSO is available
//     to any org_admin unconditionally (matches the server-side
//     `requirePermission('org:update')`-only gate in sso.router.ts).
//   - Group mappings are org_role-only — Clickroom's `SsoMappingTarget` enum
//     has no `team` variant, so there is no target selector or team column.
//   - Field names are camelCase throughout (Clickroom's Prisma schema has no
//     `@map` snake_case aliasing, unlike the reference implementation's).
import { Loader2, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CopyButton } from '@/components/CopyButton'
import { PageHeader } from '@/components/PageHeader'
import { SkeletonText } from '@/components/skeletons'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { track } from '@/lib/analytics'
import { trpc } from '@/lib/trpc'

type Protocol = 'saml' | 'oidc'
type OrgRole = 'org_admin' | 'member' | 'viewer'

const ORG_ROLES: OrgRole[] = ['org_admin', 'member', 'viewer']

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-start gap-2">
        <pre className="flex-1 overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
          <code>{value}</code>
        </pre>
        <CopyButton
          value={value}
          variant="outline"
          successMessage={`${label} copied`}
          ariaLabel={`Copy ${label}`}
          iconClassName="w-4 h-4"
        />
      </div>
    </div>
  )
}

// ── Connection ────────────────────────────────────────────────────────────

function ConnectionCard() {
  const utils = trpc.useUtils()
  const connectionQuery = trpc.sso.getConnection.useQuery()
  const connection = connectionQuery.data

  const [protocol, setProtocol] = useState<Protocol>('oidc')
  const [displayName, setDisplayName] = useState('')
  const [oidcIssuerUrl, setOidcIssuerUrl] = useState('')
  const [oidcClientId, setOidcClientId] = useState('')
  const [oidcClientSecret, setOidcClientSecret] = useState('')
  const [samlIdpEntityId, setSamlIdpEntityId] = useState('')
  const [samlIdpSsoUrl, setSamlIdpSsoUrl] = useState('')
  const [samlIdpX509Cert, setSamlIdpX509Cert] = useState('')
  const [samlSpEntityId, setSamlSpEntityId] = useState('')
  const [samlWantAssertionsSigned, setSamlWantAssertionsSigned] = useState(true)
  const [defaultOrgRole, setDefaultOrgRole] = useState<OrgRole>('member')
  const [enabled, setEnabled] = useState(false)

  // Hydrate the form once a connection loads.
  useEffect(() => {
    if (!connection) return
    setProtocol(connection.protocol)
    setDisplayName(connection.displayName ?? '')
    setOidcIssuerUrl(connection.oidcIssuerUrl ?? '')
    setOidcClientId(connection.oidcClientId ?? '')
    setSamlIdpEntityId(connection.samlIdpEntityId ?? '')
    setSamlIdpSsoUrl(connection.samlIdpSsoUrl ?? '')
    setSamlIdpX509Cert(connection.samlIdpX509Cert ?? '')
    setSamlSpEntityId(connection.samlSpEntityId ?? '')
    setSamlWantAssertionsSigned(connection.samlWantAssertionsSigned ?? true)
    setDefaultOrgRole((connection.defaultOrgRole as OrgRole) ?? 'member')
    setEnabled(connection.enabled ?? false)
  }, [connection])

  const upsertConnection = trpc.sso.upsertConnection.useMutation({
    onSuccess: () => {
      setOidcClientSecret('')
      track('settings_changed', { section: 'sso' })
      toast.success('Connection saved')
      utils.sso.getConnection.invalidate()
    },
    onError: (err) => toast.error(err.message),
  })

  function handleSaveConnection() {
    upsertConnection.mutate({
      protocol,
      displayName,
      oidcIssuerUrl: oidcIssuerUrl || undefined,
      oidcClientId: oidcClientId || undefined,
      oidcClientSecret: oidcClientSecret || undefined,
      samlIdpEntityId: samlIdpEntityId || undefined,
      samlIdpSsoUrl: samlIdpSsoUrl || undefined,
      samlIdpX509Cert: samlIdpX509Cert || undefined,
      samlSpEntityId: samlSpEntityId || undefined,
      samlWantAssertionsSigned,
      defaultOrgRole,
      enabled,
    })
  }

  if (connectionQuery.isPending) {
    return (
      <Card data-testid="sso-connection-card">
        <CardHeader>
          <CardTitle>Identity Provider Connection</CardTitle>
        </CardHeader>
        <CardContent>
          <SkeletonText lines={6} />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card data-testid="sso-connection-card">
      <CardHeader>
        <CardTitle>Identity Provider Connection</CardTitle>
        <CardDescription>Configure how your members authenticate through your IdP.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {upsertConnection.error && (
          <Alert variant="destructive">
            <AlertDescription>{upsertConnection.error.message}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <Label>Protocol</Label>
          <Select value={protocol} onValueChange={(v) => setProtocol(v as Protocol)}>
            <SelectTrigger className="w-full sm:max-w-xs" data-testid="sso-protocol-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="oidc">OIDC</SelectItem>
              <SelectItem value="saml">SAML 2.0</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="sso-display-name">Display name</Label>
          <Input
            id="sso-display-name"
            className="w-full sm:max-w-md"
            placeholder="e.g. Acme Okta"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        {protocol === 'oidc' ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="oidc-issuer">Issuer URL</Label>
              <Input
                id="oidc-issuer"
                placeholder="https://accounts.google.com"
                value={oidcIssuerUrl}
                onChange={(e) => setOidcIssuerUrl(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="oidc-client-id">Client ID</Label>
              <Input
                id="oidc-client-id"
                value={oidcClientId}
                onChange={(e) => setOidcClientId(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="oidc-client-secret">Client secret</Label>
              <Input
                id="oidc-client-secret"
                type="password"
                placeholder={connection?.hasClientSecret ? 'configured — leave blank to keep' : ''}
                value={oidcClientSecret}
                onChange={(e) => setOidcClientSecret(e.target.value)}
              />
              {connection?.hasClientSecret && (
                <p className="text-xs text-muted-foreground">
                  A client secret is configured. Enter a new value only to replace it.
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="saml-idp-entity">IdP entity ID</Label>
              <Input
                id="saml-idp-entity"
                value={samlIdpEntityId}
                onChange={(e) => setSamlIdpEntityId(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="saml-idp-sso">IdP SSO URL</Label>
              <Input
                id="saml-idp-sso"
                value={samlIdpSsoUrl}
                onChange={(e) => setSamlIdpSsoUrl(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="saml-idp-cert">IdP X.509 signing certificate</Label>
              <Textarea
                id="saml-idp-cert"
                rows={6}
                className="font-mono text-xs"
                placeholder="-----BEGIN CERTIFICATE-----"
                value={samlIdpX509Cert}
                onChange={(e) => setSamlIdpX509Cert(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="saml-sp-entity">SP entity ID</Label>
              <Input
                id="saml-sp-entity"
                value={samlSpEntityId}
                onChange={(e) => setSamlSpEntityId(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-3">
              <Switch
                id="saml-want-signed"
                checked={samlWantAssertionsSigned}
                onCheckedChange={setSamlWantAssertionsSigned}
              />
              <Label htmlFor="saml-want-signed" className="cursor-pointer">
                Require signed assertions
              </Label>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Label>Default org role</Label>
          <Select value={defaultOrgRole} onValueChange={(v) => setDefaultOrgRole(v as OrgRole)}>
            <SelectTrigger className="w-full sm:max-w-xs" data-testid="sso-default-role-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ORG_ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Role assigned to members with no matching group mapping.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Switch
            id="sso-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
            data-testid="sso-enabled-toggle"
          />
          <Label htmlFor="sso-enabled" className="cursor-pointer">
            Enable this connection
          </Label>
        </div>

        <Button
          onClick={handleSaveConnection}
          disabled={upsertConnection.isPending || !displayName.trim()}
        >
          {upsertConnection.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
          Save connection
        </Button>
      </CardContent>
    </Card>
  )
}

// ── Service provider details ────────────────────────────────────────────────

function SpDetailsCard() {
  const connectionQuery = trpc.sso.getConnection.useQuery()
  const spMetadataQuery = trpc.sso.getSpMetadata.useQuery(undefined, {
    enabled: !!connectionQuery.data?.id,
  })

  return (
    <Card data-testid="sso-sp-details-card">
      <CardHeader>
        <CardTitle>Service Provider Details</CardTitle>
        <CardDescription>
          {spMetadataQuery.data?.protocol === 'oidc'
            ? 'Add the callback URL as a Web redirect URI in your identity provider.'
            : 'Paste these values into your identity provider configuration.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!connectionQuery.data?.id ? (
          <p className="text-sm text-muted-foreground">
            Save a connection first to get your Service Provider details.
          </p>
        ) : spMetadataQuery.data ? (
          spMetadataQuery.data.protocol === 'oidc' ? (
            <CopyField label="Callback / Redirect URL" value={spMetadataQuery.data.callbackUrl} />
          ) : (
            <>
              <CopyField label="ACS URL" value={spMetadataQuery.data.acsUrl} />
              <CopyField label="SP Entity ID" value={spMetadataQuery.data.spEntityId} />
              <CopyField label="Metadata URL" value={spMetadataQuery.data.metadataUrl} />
            </>
          )
        ) : (
          <SkeletonText lines={3} />
        )}
      </CardContent>
    </Card>
  )
}

// ── Verified domains ─────────────────────────────────────────────────────────

function DomainsCard() {
  const utils = trpc.useUtils()
  const domainsQuery = trpc.sso.listDomains.useQuery()

  const [newDomain, setNewDomain] = useState('')
  const addDomain = trpc.sso.addDomain.useMutation({
    onSuccess: () => {
      setNewDomain('')
      utils.sso.listDomains.invalidate()
    },
    onError: (err) => toast.error(err.message),
  })
  const verifyDomain = trpc.sso.verifyDomain.useMutation({
    onSuccess: (result) => {
      utils.sso.listDomains.invalidate()
      toast[result.verified ? 'success' : 'error'](
        result.verified ? 'Domain verified' : 'TXT record not found yet — try again shortly.',
      )
    },
    onError: (err) => toast.error(err.message),
  })
  const removeDomain = trpc.sso.removeDomain.useMutation({
    onSuccess: () => utils.sso.listDomains.invalidate(),
    onError: (err) => toast.error(err.message),
  })

  const domains = domainsQuery.data ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle>Verified Domains</CardTitle>
        <CardDescription>
          Verify ownership of your email domains via DNS TXT records. Group mappings are only
          honored for verified domains.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {addDomain.error && (
          <Alert variant="destructive">
            <AlertDescription>{addDomain.error.message}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            placeholder="acme.com"
            className="w-full sm:max-w-xs"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
          />
          <Button
            onClick={() => addDomain.mutate({ domain: newDomain.trim().toLowerCase() })}
            disabled={addDomain.isPending || !newDomain.trim()}
          >
            {addDomain.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
            Add domain
          </Button>
        </div>

        {addDomain.data && (
          <Alert>
            <AlertDescription className="space-y-2">
              <p className="font-medium">
                Add this DNS TXT record to verify {addDomain.data.domain}:
              </p>
              <CopyField label="Record name" value={addDomain.data.txtRecordName} />
              <CopyField label="Value" value={addDomain.data.verificationToken} />
            </AlertDescription>
          </Alert>
        )}

        {domains.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>TXT record</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {domains.map((d) => (
                  <TableRow key={d.id} data-testid="sso-domain-row">
                    <TableCell className="font-medium">{d.domain}</TableCell>
                    <TableCell>
                      {d.verifiedAt ? (
                        <Badge className="bg-green-100 text-green-800">Verified</Badge>
                      ) : (
                        <Badge variant="outline">Pending</Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      _clickroom-verify.{d.domain}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {!d.verifiedAt && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => verifyDomain.mutate({ domainId: d.id })}
                            disabled={verifyDomain.isPending}
                          >
                            Verify
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-500 hover:text-red-600"
                          onClick={() => removeDomain.mutate({ domainId: d.id })}
                          disabled={removeDomain.isPending}
                          aria-label={`Remove domain ${d.domain}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Group mappings ───────────────────────────────────────────────────────────

function GroupMappingsCard() {
  const utils = trpc.useUtils()
  const connectionQuery = trpc.sso.getConnection.useQuery()
  const connection = connectionQuery.data

  const mappingsQuery = trpc.sso.listGroupMappings.useQuery(
    { connectionId: connection?.id ?? '' },
    { enabled: !!connection?.id },
  )

  const [mapIdpGroup, setMapIdpGroup] = useState('')
  const [mapOrgRole, setMapOrgRole] = useState<OrgRole>('member')

  const upsertMapping = trpc.sso.upsertGroupMapping.useMutation({
    onSuccess: () => {
      setMapIdpGroup('')
      utils.sso.listGroupMappings.invalidate()
    },
    onError: (err) => toast.error(err.message),
  })
  const deleteMapping = trpc.sso.deleteGroupMapping.useMutation({
    onSuccess: () => utils.sso.listGroupMappings.invalidate(),
    onError: (err) => toast.error(err.message),
  })

  function handleAddMapping() {
    if (!connection?.id || !mapIdpGroup.trim()) return
    upsertMapping.mutate({
      connectionId: connection.id,
      idpGroup: mapIdpGroup.trim(),
      orgRole: mapOrgRole,
    })
  }

  const mappings = mappingsQuery.data ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle>Group Mappings</CardTitle>
        <CardDescription>Map IdP groups to Clickroom org roles.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!connection ? (
          <p className="text-sm text-muted-foreground">
            Save a connection first to configure group mappings.
          </p>
        ) : (
          <>
            {upsertMapping.error && (
              <Alert variant="destructive">
                <AlertDescription>{upsertMapping.error.message}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label className="text-xs">IdP group</Label>
                <Input
                  placeholder="engineering"
                  className="w-full sm:w-40"
                  value={mapIdpGroup}
                  onChange={(e) => setMapIdpGroup(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Org role</Label>
                <Select value={mapOrgRole} onValueChange={(v) => setMapOrgRole(v as OrgRole)}>
                  <SelectTrigger className="w-full sm:w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ORG_ROLES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={handleAddMapping}
                disabled={upsertMapping.isPending || !mapIdpGroup.trim()}
              >
                Add mapping
              </Button>
            </div>

            {mappings.length > 0 && (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>IdP group</TableHead>
                      <TableHead>Org role</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mappings.map((m) => (
                      <TableRow key={m.id} data-testid="sso-mapping-row">
                        <TableCell className="font-medium">{m.idpGroup}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{m.orgRole}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-500 hover:text-red-600"
                            onClick={() =>
                              deleteMapping.mutate({
                                connectionId: connection.id,
                                mappingId: m.id,
                              })
                            }
                            disabled={deleteMapping.isPending}
                            aria-label={`Delete mapping for ${m.idpGroup}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ── Enforce SSO ──────────────────────────────────────────────────────────────

function EnforceCard() {
  const utils = trpc.useUtils()
  const connectionQuery = trpc.sso.getConnection.useQuery()
  const connection = connectionQuery.data

  const setEnforced = trpc.sso.setEnforced.useMutation({
    onSuccess: () => utils.sso.getConnection.invalidate(),
    onError: (err) => toast.error(err.message),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Enforce SSO</CardTitle>
        <CardDescription>
          When enforced, members on verified domains must sign in through SSO.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {setEnforced.error && (
          <Alert variant="destructive">
            <AlertDescription>{setEnforced.error.message}</AlertDescription>
          </Alert>
        )}
        <Alert>
          <AlertDescription>
            Breakglass: org admins can always sign in with their password, so your organization
            cannot lock itself out.
          </AlertDescription>
        </Alert>
        <div className="flex items-center gap-3">
          <Switch
            id="sso-enforce"
            data-testid="sso-enforce-toggle"
            checked={connection?.enforced ?? false}
            onCheckedChange={(checked) => setEnforced.mutate({ enforced: checked })}
            disabled={!connection || setEnforced.isPending}
          />
          <Label htmlFor="sso-enforce" className="cursor-pointer">
            Require SSO for verified-domain members
          </Label>
        </div>
      </CardContent>
    </Card>
  )
}

export function SsoSettingsPage() {
  return (
    <div className="flex flex-col h-full overflow-auto">
      <PageHeader
        title="Single Sign-On"
        subtitle="Configure SAML or OIDC so members can authenticate through your identity provider."
      />
      <div className="p-4 md:p-6 space-y-6">
        <ConnectionCard />
        <SpDetailsCard />
        <DomainsCard />
        <GroupMappingsCard />
        <EnforceCard />
      </div>
    </div>
  )
}
