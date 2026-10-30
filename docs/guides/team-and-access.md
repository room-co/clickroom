# Team and access

Everything here lives in the organization, so you need the **Admin** role to change it.

## Roles

| Role | Can do |
|---|---|
| **Admin** | Everything: members, invites, single sign-on, AI provider key, projects, keys, flags |
| **Member** | Work with data and configuration: projects, API keys, flags, experiments, insights, segments, surveys |
| **Viewer** | Read-only access to the dashboard and flags |

## Invite someone

Clickroom does not send email, so an invite is a link you pass on yourself.

1. Sidebar **Settings**, tab **Team**.
2. Click **Invite member**.
3. Enter the person's email and choose a role (**Member**, **Viewer** or **Admin**).
4. Click **Generate link**.
5. Copy the link and send it to them through chat or email. It looks like
   `https://YOUR_CLICKROOM_HOST/invite/<token>`.

The link works for seven days. The invitee opens it, creates their account with a name, email and password, and joins your
organization with the role you chose. The link is shown only once. If you lose it, find the invite
under **Pending Invites**, click **Revoke**, and invite them again. Inviting the same email again
also replaces the earlier link.

Who may sign up on their own is a server setting (`SIGNUP_MODE`). See
[accounts](../self-host/accounts.md).

## Forgot a password

There is no email reset. An operator with shell access resets it from the server. See
[accounts](../self-host/accounts.md#reset-a-users-password).

## Single sign-on (SAML and OIDC)

Sidebar **Settings**, then the **Single Sign-On** card, opens the SSO settings. Admins can:

1. **Identity Provider Connection.** Choose the protocol. For **OIDC** enter the issuer URL, client
   ID and client secret, and give your IdP the callback URL shown on the page. For **SAML 2.0**
   enter the IdP entity ID, SSO URL and X.509 signing certificate, and give your IdP the SP entity
   ID, ACS URL and metadata URL shown under **Service Provider Details**.
2. **Verified Domains.** Add your email domain. Clickroom shows a TXT record name and value to add
   to your DNS; verify it afterwards.
3. **Default org role.** The role new SSO users receive.
4. **Group Mappings.** Map an IdP group name to an organization role.
5. **Enforce SSO.** When on, members of verified domains must sign in through the identity
   provider.

Keep one working password login for an Admin until you have tested SSO, so a configuration mistake
does not lock you out. SSO needs the public URL of your install to be correct, because the IdP
redirects back to it.

Users who sign in only through SSO have no Clickroom password.
