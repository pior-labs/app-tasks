# Tasks

Pior Labs Tasks. A signed-in user can create tasks, see their saved tasks,
mark a task complete or clear it again, rename a task and delete a task.
Deletion is permanent: there is no archive or undo. Notes, projects, priorities
and due dates are not implemented.

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
| `PATCH /api/tasks/:id` | `{ "title": string }`, `{ "completed": boolean }`, or both | 200 `{ "task": {...} }` with the stored task |
| `DELETE /api/tasks/:id` | none | 204 with no body; the task is removed permanently |

A task is `{ id, title, completed, createdAt, updatedAt }`. Errors are
`{ "error": code, "message": text }` with stable codes: 400 `invalid_json`,
`invalid_title`, `invalid_completed`, `invalid_update` or `invalid_task_id`; 403
`forbidden_origin` when a `POST`/`PATCH`/`DELETE` does not carry the application
origin (`BETTER_AUTH_URL`) in `Origin`; 404 `task_not_found` for an id that does
not exist, was already deleted or belongs to another user (the cases are
indistinguishable).

`PATCH` changes only the fields that are sent. A title follows the same rules
as on create, from one shared definition in `packages/api/src/tasks.ts`. A body
with neither `title` nor `completed` (an empty object, or anything that is not
an object) is 400 `invalid_update`; before renaming existed such a body was
answered with `invalid_completed`. If either field is invalid nothing is
changed. Other fields, such as `userId` or `id`, are ignored. Every successful
update sets `updatedAt`; `createdAt`, and so the list order, never changes.
Both writes filter on the session user in the statement that changes the row.

Title rules, applied by the API and mirrored by the forms: the title is trimmed;
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

Each row has an Edit and a Delete control next to its checkbox, each named
after the task (for example `Edit "Buy oat milk"`).

- Edit turns the title into a text field with Save and Cancel, one row at a
  time. Enter saves and Escape cancels. The field applies the same title rules
  as the add form and shows the message under the field. A title that is
  unchanged after trimming is not sent. The row shows the new title only after
  the server stored it; if saving fails the row stays in edit mode with the
  typed text and an error. While a row is edited its checkbox is hidden, and
  Edit waits while a completion change for that task is pending.
- Delete asks in the row ("Delete this task?" with Confirm and Cancel) instead
  of using a browser dialog. Focus lands on Cancel. The row disappears only
  after the server deleted the task; if that fails the row and the question
  stay and an error is shown. Deleting the last task shows the empty state.
- Focus is moved on purpose: into the field when editing starts, back to the
  row's Edit control after saving or cancelling, back to Delete after
  cancelling a delete, and after a delete to the first control of the next row,
  else the previous row, else the new-task field.
- If the server answers 404 to a rename or delete (the task was removed
  elsewhere), the row is removed and a notice says the task no longer exists.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
# TEST_DATABASE_URL is a private local TCP connection for a role with CREATEDB.
# Without it, the suite creates a disposable PostgreSQL 16 Docker container.
pnpm test
pnpm db:migrate
# Browser end-to-end suite, see below. Not part of `pnpm test` or `pnpm verify`.
pnpm --filter @tasks/e2e exec playwright install chromium
pnpm test:e2e
```

`pnpm test` runs the API integration tests and then the web component tests;
`pnpm verify` runs typecheck, tests and build. Neither needs a browser.

Each API test file creates/migrates/drops its own unique disposable
`tasks_test_*` database. They never truncate the development database. Auth
tests exercise PKCE callbacks, state and issuer checks, replay, invalid profiles,
session persistence/renewal/expiry, cookie isolation, CSRF and sign-out using a
fixture provider. Task tests cover create/list, title validation, completing and
clearing, renaming (with the create title cases reused against `PATCH`),
deleting, persistence across sign-out, a new session and a second app instance
on the same database, per-user isolation, session enforcement and the origin
check. They do not prove hosted SSO.

Web component tests (`packages/web/src/*.test.tsx`) use Vitest, jsdom and
Testing Library with `fetch` stubbed. They cover the signed-out view, the task
list states, creating, completing, renaming and deleting tasks, failures,
pending states, focus targets and 401 handling. They do not run a real browser
or the real API.

The end-to-end suite (`packages/e2e`, Playwright, headless Chromium) drives the
real application in a browser. `pnpm test:e2e` starts the Vite dev server on
port 5273 and the real API on port 3173 (`packages/api/test/e2e-server.ts`), so
it does not collide with, or attach to, an application running on 5173 and
3000. Set `E2E_WEB_PORT` or `E2E_API_PORT` to use other ports. The API runs on
the same test fixture as the API tests: a new disposable `tasks_test_*`
database (Docker, or `TEST_DATABASE_URL`) and the fixture SSO provider, where
the suite signs in by following the "Household One" or "Household Two" link.
It never uses `tasks_dev`, `.env.local` credentials or hosted SSO, and the
database is dropped when the run ends. The suite covers sign-in, create,
complete, rename by keyboard and by pointer, cancelling a rename, delete with
confirmation, cancelling a delete, persistence across reloads, focus after each
action, a task removed in another tab, an ended session, and that a second user
sees none of the first user's tasks. `@playwright/test` is a dev dependency of
`@tasks/e2e` only, so it is installed neither with the API or web package nor
in either image. The first run needs the browser download shown above; on a
machine without Chromium's system libraries add `--with-deps`, which needs
root. Failures leave a trace and a screenshot under
`packages/e2e/test-results/`.

CI runs typechecks, API and web tests, production builds and then the
end-to-end suite.

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

Rename and delete verification evidence: typecheck, production builds, the API
tests (eight auth, fifteen task), 39 web component tests and the eight
end-to-end tests passed locally on Node 24 against disposable databases, with
the end-to-end suite in headless Chromium using fixture sign-in. The change
adds no migration. It has not been checked against hosted SSO or a deployed
site.

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
