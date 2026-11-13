# Tasks

Pior Labs Tasks. A signed-in user can create tasks, see their saved tasks, and
mark a task complete or clear it again. Editing, deletion, notes, projects,
priorities and due dates are not implemented.

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
are persisted in Tasks' own database, alongside the task-domain `tasks` table.

`GET /api/me` requires an unexpired local session and returns only ID/name/email.
`/health` and `/api/health` are public liveness endpoints. Other API routes after
the auth boundary require a session. Sign-out revokes only the Tasks session.
Cookies use the unique `tasks` prefix: `tasks.session_token` and the pinned
library's emitted `tasks.state`, with HttpOnly/SameSite=Lax and Secure on HTTPS.

Exact callbacks registered by the companion service-auth change:

- http://localhost:5173/api/auth/oauth2/callback/auth-pior
- https://tasks.szarans.ca/api/auth/oauth2/callback/auth-pior

## Tasks

Each row in `tasks` belongs to one app-local user (`user_id`, cascade delete)
and has a `title`, a `completed` boolean and timestamps. The owner is always
taken from the server session, never from the request, and `user_id` is not
returned. All task routes sit behind the session boundary and return 401
without a valid session.

| Route | Request | Success |
| --- | --- | --- |
| `GET /api/tasks` | none | 200 `{ "tasks": [...] }`, the session user's tasks only, newest first |
| `POST /api/tasks` | `{ "title": string }` | 201 `{ "task": {...} }`; the title is trimmed, 1 to 200 characters |
| `PATCH /api/tasks/:id` | `{ "completed": boolean }` | 200 `{ "task": {...} }` |

A task is `{ id, title, completed, createdAt, updatedAt }`. Errors are
`{ "error": code, "message": text }` with stable codes: 400 `invalid_json`,
`invalid_title`, `invalid_completed` or `invalid_task_id`; 403
`forbidden_origin` when a `POST`/`PATCH` does not carry the application origin
(`BETTER_AUTH_URL`) in `Origin`; 404 `task_not_found` for an id that does not
exist or belongs to another user (the two cases are indistinguishable).

Title rules, applied by the API and mirrored by the form: the title is trimmed;
a title with nothing visible (only whitespace, control characters or invisible
characters such as a zero width space) is rejected like an empty one; a title
containing a null character is rejected because PostgreSQL cannot store it; the
200 limit counts Unicode code points, so an emoji is one character. Visible
titles are stored unchanged apart from trimming.

The signed-in page shows an add-task form and the task list, with distinct
loading, empty, load-failure (with retry), create-failure and update-failure
states. A checkbox changes only after the server stores the new state. While a
request is pending its control ignores repeat input but keeps keyboard focus,
and after a task is added focus returns to the title field. A 401 from a task
request returns the page to the signed-out view, except after an explicit
sign-out.

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

`pnpm test` runs the API integration tests and then the web component tests;
`pnpm verify` runs typecheck, tests and build.

Each API test file creates/migrates/drops its own unique disposable
`tasks_test_*` database. They never truncate the development database. Auth
tests exercise PKCE callbacks, state and issuer checks, replay, invalid profiles,
session persistence/renewal/expiry, cookie isolation, CSRF and sign-out using a
fixture provider. Task tests cover create/list, title validation, completing and
clearing, persistence across sign-out, a new session and a second app instance
on the same database, per-user isolation, session enforcement and the origin
check. They do not prove hosted SSO.

Web component tests (`packages/web/src/*.test.tsx`) use Vitest, jsdom and
Testing Library with `fetch` stubbed. They cover the signed-out view, the task
list states, creating and completing tasks, failures and 401 handling. They do
not run a real browser or the real API. CI runs typechecks, API and web tests
and production builds.

Vitest is an optional peer dependency of Better Auth. The root `pnpm.overrides`
entry `better-auth>vitest` keeps the web test tooling out of the API's
dependency tree and production image.

`pnpm db:generate` generates checked-in app-owned migrations. It does not connect
to a database, but the Drizzle configuration requires `DATABASE_URL` or
`DATABASE_URL_FILE` to be set. Verify the local
connection with workspace tooling before applying migrations. Production reads
only its mounted platform connection file.

## Integration and production rollout

Deployment is manual, restricted to `main`, using the `PRODUCTION` environment
and repository-scoped runner labels `self-hosted`, `linux`, `app-tasks`.
The runner needs Python 3, Docker Compose, curl, and write access to `DEPLOY_DIR`.
Configure the required Actions variable `DEPLOY_DIR=/opt/docker/app-tasks`,
GitHub Packages access for this repository, and the runner before dispatch.

Set these separate Actions secrets:

- `COMPOSE_PROJECT_NAME`: `tasks` for a new project.
- `CENTRAL_AUTH_CLIENT_SECRET`: the same private value as Auth's `TASKS_CLIENT_SECRET`.
- `BETTER_AUTH_SECRET`: a separate stable application session secret, at least 32 characters.

`APP_ENV` is no longer used. Public runtime configuration has versioned production
defaults and individual optional Actions variable overrides. See the complete
[production settings table](docs/DEPLOYMENT.md#individual-production-settings).
No additional variables are needed for the standard Tasks production setup.

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
4. Merge Tasks, wait for its main CI images, and dispatch Deploy with that CI
   run ID. It pulls exact digests, applies app migrations, starts containers,
   and probes health and frontend through Caddy.
5. Verify browser SSO, current user, local session, sign-out and expiry; then
   verify production routing and persistence. Review backup coverage before data.

Task feature verification evidence: typecheck, production builds, fifteen
disposable-database API tests (eight auth, seven task) and fifteen web component
tests passed locally. Migration `0001` was applied only to disposable test
databases; it has not been applied to `tasks_dev` or production, and the task
feature has not been checked in a real browser or against hosted SSO.

Foundation verification evidence: migration `0000` applied to `tasks_dev`; typecheck,
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

## Verified CI releases

CI publishes immutable images after validation; production deployment is manual
and selects a successful main CI run. Configure the separate
`COMPOSE_PROJECT_NAME` Actions secret and follow [deployment operations](docs/DEPLOYMENT.md)
for activation, exact run selection, persistent-data boundaries and recovery.
