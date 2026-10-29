# Private Cloudflare deployment

This setup is independent of `server/wrangler.toml`, `.env.production`, the existing
GitHub deployment workflows, and `public/CNAME`. Those files remain unchanged.
Use Node.js 22+ and install both locked dependency sets (`npm ci` at the root and
`npm ci --prefix server`). Run the commands below from the repository root.

**Nothing here grants deployment/resource-creation permission.** Obtain explicit
approval before creating resources, initializing a database, uploading secrets,
or deploying. Local private checks never provision cloud resources. The later
approved Worker deployment creates its Worker if it does not already exist.

## Inputs you must supply

| Input | Destination | How to obtain it |
|---|---|---|
| Your Cloudflare account ID (32 hex characters) | `account_id` in `server/wrangler.private.toml` | Your Cloudflare account dashboard; verify the selected Wrangler account with `wrangler whoami` |
| Private Worker name | `name` in that TOML | Choose your own name; `eric-zf-api` is only a proposal |
| Private D1 name and UUID | The single `DB` binding in that TOML | Create your own database after approval; `eric-zf-db` is only a proposal |
| Actual private Worker HTTPS origin | `VITE_API_URL` in `.env.private.local` | The URL assigned to your Worker; a `workers.dev` hostname must begin with your configured Worker name |
| Stable private frontend HTTPS origin | `ALLOWED_ORIGIN` in the TOML and `PRIVATE_FRONTEND_ORIGIN` in `.env.private.local` | Your assigned Pages URL or own custom domain; no path or trailing slash |
| Private Pages project name | `PRIVATE_PAGES_PROJECT` in `.env.private.local` | Your own Pages project, with production branch `main` |
| Your Google OAuth **Web application** client ID | `GOOGLE_CLIENT_ID` in the TOML and `VITE_GOOGLE_CLIENT_ID` in `.env.private.local` | Create in your own Google Cloud project; authorize the exact frontend origin |
| Fresh random session-signing secret | `SESSION_SECRET` in `server/.secrets/private-worker.env` | Generate locally with at least 32 random bytes; never paste into chat or frontend settings |
| Cloudflare CLI authentication | Wrangler OAuth login, or a locally supplied API token | Dashboard login alone does not authenticate Wrangler |

Account IDs, resource IDs, URLs, and Google Web client IDs are public deployment
identifiers. Session secrets and API tokens are credentials. Never place credentials
in the TOML's `[vars]`, `.env.private.local`, or any `VITE_*` variable.
No Google client secret is used by this application. Resource ownership cannot be
proven by offline checks; verify all resources belong to your selected account.

## Prepare and inspect locally

The verified Pages project is `eric-zf-farm`, with frontend origin
`https://eric-zf-farm.pages.dev`. In your Google OAuth Web application client, add
that exact address under **Authorized JavaScript origins** (no path or trailing
slash). This application uses Google Identity Services' JavaScript callback and
ID-token verification, so it does not need a Google Client Secret or a redirect
endpoint for this flow.

Paste your **Client ID only** into `GOOGLE_CLIENT_ID` under `[vars]` in
`server/wrangler.private.toml` and into `VITE_GOOGLE_CLIENT_ID` in the ignored root
`.env.private.local`. Both values must match. `ALLOWED_ORIGIN` in the private TOML
must match `PRIVATE_FRONTEND_ORIGIN` in the local file, both set to the exact Pages
origin above. Keep `PRIVATE_PAGES_PROJECT=eric-zf-farm`. The private API origin must
be the verified URL of your own `eric-zf-api` Worker; a placeholder is not a ready
deployment. Never paste the Google Client Secret into either file or frontend
code. The separate game `SESSION_SECRET` remains a backend-only signing secret.

1. Fill the required public identifiers in `server/wrangler.private.toml`. Keep
   its single `DB` binding and gameplay settings. Do not add named environments,
   routes, service bindings, build hooks, or timer overrides. Native rate-limit
   namespace IDs 3001/3002/3003 must be unused by other limiters in your account.
2. Copy `.env.private.example` to `.env.private.local` and fill all four settings.
   The local file is git-ignored. It has no fallback to `.env.production`,
   `.env.local`, or shell `VITE_*` values.
3. Configure your Google Web client with the exact frontend origin. Keep
   `DEV_AUTH="0"`; development fixtures must not be exposed on the hosted server.
   This setup creates a separate service, not an invite-only player allowlist.
4. Run:

   ```sh
   npm run private:check
   npm run private:plan
   npm run private:dry-run
   npm run private:build-preflight
   npm run build:private
   ```

`private:check` and `private:plan` fail until all public inputs are complete.
`private:dry-run` permits the template's missing public identities **only for local
Worker compilation**, reports the blockers, and cannot upload, create resources,
load a deployment secret file, or initialize a database. Worker output is isolated
under `server/.wrangler/private-dry-run/`. A successful compile does not establish
that an account, database, URL or Google credential exists or belongs to you.

`private:build-preflight` performs a separate local-only build with explicitly
synthetic identifiers into a temporary directory, audits its JS/CSP/source maps
and service worker, and deletes the output. It deliberately sets hostile upstream
ambient environment variables to verify isolation. It never fills in your real
configuration, uploads anything, or leaves a deployable `dist-private/` bundle.

`build:private` requires complete matching public settings, typechecks the client,
builds with `vite.private.config.ts` into ignored `dist-private/`, removes the
upstream `CNAME`, and audits text assets, source maps, CSP and service worker for
upstream hosts. It does not change the normal `dist/` build. Keep the API and site
URLs as exact HTTPS origins. The private Vite config pins both JS constants and
CSP to the same explicitly supplied API, regardless of ambient `VITE_*` values.

## Resource creation and fresh database setup — approval required

These are reference commands, **not executed by any local check**. Replace names
and account IDs with your own. Do not use the existing `deploy`, `deploy:prod`,
`db:apply:*`, `db:init:local`, or GitHub deployment workflows for this private stack.
Always inspect `private:plan` before any remote action. The original staging and
production names, IDs, domain and OAuth client ID are rejected by private checks.

Authenticate and select your own account:

```sh
./server/node_modules/.bin/wrangler login
./server/node_modules/.bin/wrangler whoami
export CLOUDFLARE_ACCOUNT_ID='<YOUR_ACCOUNT_ID>'
```

After resource-creation approval, create a D1 database and a Direct Upload Pages
project. Use your chosen names, not the original project's names:

```sh
./server/node_modules/.bin/wrangler d1 create eric-zf-db \
  --config server/wrangler.private.toml
./server/node_modules/.bin/wrangler pages project create YOUR_PRIVATE_PAGES_PROJECT \
  --production-branch main
```

Copy the **returned** D1 UUID into the existing private `DB` binding. Do not append
a second binding. Record the actual assigned Pages hostname; do not assume its
availability. A Worker is created by the later Worker deployment, so no blank
Worker needs to be created manually. Confirm your account's `workers.dev` subdomain.

After separate database-initialization approval, apply the current schema and its
baseline ledger to your **fresh** private database, using its actual chosen name:

```sh
./server/node_modules/.bin/wrangler d1 execute eric-zf-db --remote \
  --config server/wrangler.private.toml --file server/schema.sql
./server/node_modules/.bin/wrangler d1 execute eric-zf-db --remote \
  --config server/wrangler.private.toml --file server/scripts/baseline-migrations.sql
```

Do not replay historical migrations after installing the schema snapshot. For
future upgrades, follow `server/migrations/README.md` with the private config and
database name, and obtain migration approval first. Growth Time Control needs no
new schema migration; its adjustments use the existing JSON documents.

## Deployment — approval required

Generate the session secret locally (for example `openssl rand -hex 32`), then
store only `SESSION_SECRET=<generated value>` in ignored
`server/.secrets/private-worker.env`. Cloudflare stores it as a Worker secret, not
a frontend variable. Keep this file private. The command never prints its content.

Without `--execute`, both commands below refuse to run any deployment. That flag
is an extra guard, **not a substitute for explicit user approval**:

```sh
npm run deploy:private:worker -- --execute
# Verify the actual API URL, then update .env.private.local if necessary.
npm run deploy:private:frontend -- --execute
```

Worker deployment pins the private config, top-level environment, account ID and
secret file, and first runs the existing migration/catalog checks, typecheck, unit
and local integration suites. Frontend deployment rebuilds and audits
`dist-private/` immediately before upload, pins the account and Pages project, and
uses production branch `main`. No arbitrary Wrangler CLI flags are forwarded.
Frontend Pages commands do not support `--config`; they run at the repository
root, outside the server's original Wrangler project, with the account explicitly
set. A mismatched shell `CLOUDFLARE_ACCOUNT_ID` blocks the guarded commands.

The private config enables `GROWTH_TIME_CONTROL="1"` while retaining PvP,
formation defense, Black Market, normal cooldowns, logging and daily cleanup.
Reload clients after enabling it: `/bootstrap` must report
`growthTimeControlEnabled: true`. Normal collection/reward logic remains unchanged.

## Verify isolation and Free-plan suitability

The private build audit rejects upstream Worker/domain references, a mismatched
API CSP, or upload override files such as `CNAME`, `_worker.js`, and `_redirects`.
It also rejects the upstream D1 UUIDs/names, Worker names and Google client ID at
configuration validation time. Direct/raw Wrangler commands bypass these guards;
use the documented guarded deployment commands.

After an approved deployment, record Network traffic from a fresh browser session
on your own Pages URL. Sign in, plant, advance time, harvest trees, combine, reload,
and reconnect from another device. All game API requests must go to your API;
Google authentication requests are expected. There must be zero requests to the
original Workers or site. Confirm your deployed Worker's `DB` binding shows your
UUID. Keep the existing writer-lease takeover flow when switching devices.

The static frontend fits Pages Free's file count/size limits and needs Wrangler
Direct Upload (it exceeds the dashboard's 1,000-file upload limit). The private
setup does not require paid storage services or a purchased domain. Full unchanged
online gameplay on Workers Free remains **unverified**: server battle replay can
hit the Free plan's 10 ms CPU limit even with one player. Measure representative
raids, Epic Boss fights, PvP and cleanup after deployment before promising Free
plan operation. Check current Cloudflare quotas before provisioning:

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/pages/get-started/direct-upload/
