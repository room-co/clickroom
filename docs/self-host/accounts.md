# Accounts, sign-up and password reset

Clickroom self-host has **no mail server**. Invites are links you copy, and password resets are done
from the command line on the server.

All commands below run from the install directory (`cd ~/clickroom`).

## The owner account

On a fresh install the first sign-up becomes the **owner** of the organization. After that, who can
sign up is controlled by `SIGNUP_MODE` in `.env`.

| `SIGNUP_MODE` | Behavior |
|---|---|
| `first_user_only` (default) | The first sign-up creates the owner. After that, public sign-up is closed; people join by invitation. |
| `open` | Anyone who can reach the URL can create an account. Only use this on a private network or behind access control. |
| `closed` | No self-service sign-up at all. Create users through invitations from an existing owner. |

A typo in the value (for example `opne`) makes the API refuse to start, by design.

Change it:

```bash
nano .env                # SIGNUP_MODE=closed
docker compose up -d
```

## Invite teammates

An owner invites people from the organization's members page in the dashboard. Because there is no
email, copy the generated invite link and send it yourself.

## Reset a user's password

```bash
docker compose --profile tools run --rm cli pnpm user:reset-password --email you@example.com
```

(`docker compose run --rm cli ...` also works: `run` starts a profile service by name.) It generates a
new password, prints it **once**, and signs the user out of all sessions. To set a specific password:

```bash
docker compose run --rm cli pnpm user:reset-password --email you@example.com --password 'a-long-new-password'
```

Users who sign in through SSO have no password; the command tells you so and exits with an error.
If you lose the owner login, this is the recovery path.

## The admin console (optional)

The admin console is a separate internal tool for operating the instance, with its own accounts,
and **mandatory TOTP** two-factor sign-in. Enable it first: [Optional features](optional-features.md#admin-console).

Create an admin (the email is required):

```bash
docker compose run --rm cli pnpm admin:create --email you@example.com --name "Your Name"
```

The generated password is printed once to your terminal (`ADMIN_PASSWORD_SINK=stdout`, the self-host
default). Two-factor is enrolled on first sign-in to the admin console. To issue a new password for
an existing admin, add `--rotate`.

Alternative, non-interactive: set both `CLICKROOM_ADMIN_EMAIL` and `CLICKROOM_ADMIN_PASSWORD`
(at least 12 characters) in `.env` and run `docker compose up -d`. The API creates that admin at boot
if it does not exist and never rotates an existing one. Less secure, because the password sits in
`.env`; remove those two lines afterwards. TOTP is still required.

`ADMIN_PASSWORD_SINK` accepts `stdout`, `env` or `ssm`; `ssm` stores the password in AWS SSM and is
for the hosted service. Leave the default.

## Locked out checklist

| Situation | Fix |
|---|---|
| Forgot owner/user password | `user:reset-password` above |
| No admin exists | `admin:create` above |
| Forgot admin password | `admin:create --email <e> --rotate` (changes the password only) |
| Lost admin TOTP device | No CLI command resets two-factor; `--rotate` only changes the password. Ask on the issue tracker. |
