# Tasks

Pior Labs Tasks foundation. The first release identifies the signed-in user and
provides sign-in/sign-out. Task features are deferred.

React 19/Vite, Hono, PostgreSQL/Drizzle, pnpm 10.8.1, published
`@pior-labs/design-system`, and Better Auth 1.6.20 application sessions.
The starting source is `pior-labs/template-webapp` revision
`9b719955088ab31dd294ad84f7a9f1a0ac5a5e72`. The private GitHub repository was
generated using GitHub template generation; foundation changes are separate
commits on its generated baseline.

## Local development

Use Node 22 and the declared pnpm version. From the workspace root:

```sh
bash scripts/setup-dev.sh tasks --configure-only
# Set the dedicated, registered client secret privately in app-tasks/.env.local.
# Supply GITHUB_TOKEN with GitHub Packages read access through private configuration.
bash scripts/setup-dev.sh tasks
bash scripts/check-dev.sh tasks --database-only
cd app-tasks
pnpm dev
```

Frontend: http://localhost:5173. Vite proxies `/api` to localhost:3000. Run only
one platform frontend at a time. Setup provisions only `tasks_dev` when Tasks
is selected and preserves existing credentials/state. Default workspace setup
selection remains unchanged. `.env.local` takes precedence over `.env` outside
production; process configuration takes precedence over both. No seed data is
required. Secrets stay in ignored files with mode 0600.

Normal SSO uses https://auth.szarans.ca/api/auth and dedicated client ID `tasks`.
The local client secret must match Auth's private `TASKS_CLIENT_SECRET`;
`BETTER_AUTH_SECRET` is a separate generated session secret. Setting a secret
locally does not register it with Auth. No credentials belong in `VITE_*`.

For an authenticated GitHub CLI, enable package read access once and expose the
credential only to the current shell (do not enable shell tracing):

```sh
gh auth refresh --hostname github.com --scopes read:packages
export GITHUB_TOKEN="$(gh auth token)"
```

A repository-capable login alone may lack `read:packages`. The new repository's
CI has successfully installed the published design system with its Actions token.

## Authentication

The `auth-pior` OAuth client uses discovery, PKCE, issuer validation, and
authenticated UserInfo. Provider identities are linked by subject; email-based
account linking is disabled. Local users, sessions, accounts and OAuth state
are persisted in Tasks' own database. There is no task-domain schema yet.

`GET /api/me` requires an unexpired local session and returns only ID/name/email.
`/health` and `/api/health` are public liveness endpoints. Other API routes after
the auth boundary require a session. Sign-out revokes only the Tasks session.
Cookies use the unique `tasks` prefix: `tasks.session_token` and the pinned
library's emitted `tasks.state`, with HttpOnly/SameSite=Lax and Secure on HTTPS.

Exact callbacks registered by the companion service-auth change:

- http://localhost:5173/api/auth/oauth2/callback/auth-pior
- https://tasks.szarans.ca/api/auth/oauth2/callback/auth-pior

## Verification

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
# TEST_DATABASE_URL is a private local TCP connection for a role with CREATEDB.
# Without it, the suite creates a disposable PostgreSQL 16 Docker container.
pnpm test
pnpm db:migrate
```

Auth tests create/migrate/drop a unique disposable `tasks_test_*` database. They
never truncate the development database. They exercise PKCE callbacks, state and
issuer checks, replay, invalid profiles, session persistence/renewal/expiry,
cookie isolation, CSRF and sign-out using a fixture provider. They do not prove
hosted SSO. CI runs typechecks, auth tests and production builds.

`pnpm db:generate` generates checked-in app-owned migrations. Verify the local
connection with workspace tooling before applying migrations. Production reads
only its mounted platform connection file.

## Integration and production rollout

Deployment is manual, restricted to `main`, using the `PRODUCTION` environment
and repository-scoped runner labels `self-hosted`, `linux`, `app-tasks`.
The runner needs Docker Compose, rsync, curl, and write access to `DEPLOY_DIR`.
Configure `DEPLOY_DIR` (an absolute dedicated directory), `APP_ENV`, GitHub
Packages access for this repository, and the runner before dispatch.

`APP_ENV` must contain the production settings from `.env.example`, including:

```dotenv
APP_SLUG=tasks
COMPOSE_PROJECT_NAME=tasks
BETTER_AUTH_URL=https://tasks.szarans.ca
BETTER_AUTH_TRUSTED_ORIGINS=https://tasks.szarans.ca
PUBLIC_BASE_URL=https://tasks.szarans.ca
CENTRAL_AUTH_ISSUER=https://auth.szarans.ca/api/auth
CENTRAL_AUTH_CLIENT_ID=tasks
CENTRAL_AUTH_CLIENT_SECRET=<same-private-value-as-Auth-TASKS_CLIENT_SECRET>
BETTER_AUTH_SECRET=<separate-private-session-secret>
PLATFORM_DATABASE_URL_FILE=/opt/docker/pior-labs/secrets/app-tasks/database-url
```

Do not place production database passwords in GitHub. Production Compose clears
`DATABASE_URL`, mounts the platform-generated file read-only, and sets
`DATABASE_URL_FILE=/run/secrets/database_url`. API joins `pior_data` and
`pior_edge` as `tasks-api`; static web joins only `pior_edge` as `tasks-web`.
Platform Caddy routes `/api/*` to `tasks-api:3000`, other paths to `tasks-web:80`.
The web container serves static files only. Wildcard DNS needs no new record.

Rollout checklist, with human review and merge for each repository:

1. Configure package access for this generated repository, its runner,
   `DEPLOY_DIR`, and private app/Auth secrets.
2. Merge the Auth registration; run **Bootstrap Auth Production** with existing
   seed-user configuration, then **Deploy Auth Production** to reload clients.
3. Merge/deploy platform changes to provision database `tasks`, role `tasks_app`,
   connection secret, and explicit HTTPS ingress.
4. Merge Tasks and dispatch Deploy. It builds locked images, applies app
   migrations, starts containers, and probes health and frontend through Caddy.
5. Verify browser SSO, current user, local session, sign-out and expiry; then
   verify production routing and persistence. Review backup coverage before data.

Current verification evidence: migration applied to `tasks_dev`; typecheck,
production build and eight disposable-database auth tests passed. Frontend and
proxied health returned 200, unauthenticated `/api/me` returned 401. Browser
smoke checks covered signed-out UI and synthetic signed-in UI, with no mobile
horizontal overflow. A clean checkout/empty package store installed locked
dependencies with the refreshed CLI login. Both Docker images built, including
private package access through a BuildKit secret; API health, protected-boundary
and static-web container probes passed. Application CI and platform validation
CI passed.

Hosted Auth registration is activated at revision
`bd5e4748b762953e2c2fcaa1e8e8602377d3c539`:

- [Bootstrap, successful attempt 2](https://github.com/pior-labs/service-auth/actions/runs/42739434727)
- [Deploy, successful](https://github.com/pior-labs/service-auth/actions/runs/42741226539)

The initial Bootstrap build failed on runner build-network DNS before migrations
or seeding. After the operator configured a reachable LAN resolver for Docker,
the uncached build DNS probe and Bootstrap retry succeeded. The host repair is
documented in platform-deploy's runner operations guide. The initial client
error predates activation; the real browser now reaches hosted sign-in without
that error, and the user confirmed a successful callback to Tasks showing their
current user. The central account link is persisted in the local database.
The user also confirmed real app sign-out and successful sign-in afterward.
Expiry and revocation have passing regression coverage; a week-long live expiry
was not observed. Tasks itself has not been deployed in production.
