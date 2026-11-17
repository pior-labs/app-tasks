# Tasks

Pior Labs Tasks. A signed-in user can create tasks, see their saved tasks,
mark a task complete or clear it again, rename a task, give a task an optional
due date and delete a task. Open tasks are grouped by when they are due.
Deletion is permanent: there is no archive or undo. Notes, projects and
priorities are not implemented.

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

Then add `//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}` to your user-level `~/.npmrc` (current pnpm ignores credentials in the committed `.npmrc`).
The workspace setup script supplies the token itself during setup.

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
and has a `title`, a `completed` boolean, an optional `due_date` and
timestamps. `due_date` is a nullable PostgreSQL `date` (a calendar day with no
time or timezone), added by migration `0002`; existing rows get `NULL`, and
the migration only adds the column, so an image built before it keeps working
against the migrated table. Drizzle reads and writes it in string mode, so the
server never converts it between timezones. The owner is always
taken from the server session, never from the request, and `user_id` is not
returned. All task routes sit behind the session boundary and return 401
without a valid session.

| Route | Request | Success |
| --- | --- | --- |
| `GET /api/tasks` | none | 200 `{ "tasks": [...] }`, the session user's tasks only, newest first |
| `POST /api/tasks` | `{ "title": string, "dueDate"?: string or null }` | 201 `{ "task": {...} }`; the title is trimmed, 1 to 200 characters |
| `PATCH /api/tasks/:id` | any of `{ "title": string }`, `{ "completed": boolean }`, `{ "dueDate": string or null }`, together or alone | 200 `{ "task": {...} }` with the stored task |
| `DELETE /api/tasks/:id` | none | 204 with no body; the task is removed permanently |

A task is `{ id, title, completed, dueDate, createdAt, updatedAt }`, where
`dueDate` is a `"YYYY-MM-DD"` string or `null`. Errors are
`{ "error": code, "message": text }` with stable codes: 400 `invalid_json`,
`invalid_title`, `invalid_completed`, `invalid_due_date`, `invalid_update` or
`invalid_task_id`; 403
`forbidden_origin` when a `POST`/`PATCH`/`DELETE` does not carry the application
origin (`BETTER_AUTH_URL`) in `Origin`; 404 `task_not_found` for an id that does
not exist, was already deleted or belongs to another user (the cases are
indistinguishable).

`PATCH` changes only the fields that are sent. A title follows the same rules
as on create, from one shared definition in `packages/api/src/tasks.ts`. A body
with none of `title`, `completed` and `dueDate` (an empty object, or anything
that is not an object) is 400 `invalid_update`, and its message names all
three; before renaming existed such a body was answered with
`invalid_completed`. If any field is invalid nothing is changed, and the first
invalid field (in the order title, completed, due date) decides the code. Other fields, such as `userId` or `id`, are ignored. Every successful
update sets `updatedAt`; `createdAt`, and so the list order, never changes.
Both writes filter on the session user in the statement that changes the row.

Title rules, applied by the API and mirrored by the forms: the title is trimmed;
a title with nothing visible (only whitespace, control characters or invisible
characters such as a zero width space) is rejected like an empty one; a title
containing a null character is rejected because PostgreSQL cannot store it; the
200 limit counts Unicode code points, so an emoji is one character. Visible
titles are stored unchanged apart from trimming.

Due date rules, from one shared definition used by `POST` and `PATCH`: a due
date is a string in the exact form `YYYY-MM-DD` that is a real calendar date
(`2026-02-30` and `2026-13-01` are refused, `2028-02-29` is accepted) from
`2025-01-01` through `2100-12-31`, both included, or `null` for no due date.
Past dates in that range are allowed. A missing `dueDate` on create means no
due date. Anything else (another format, a day that does not exist, a date
outside the range, a number or another type) is 400 `invalid_due_date` and
nothing is created or changed. The forms apply the same range.

The signed-in page shows an add-task form (a title and an optional "Due date"
field) and the task list, with distinct
loading, empty, load-failure (with retry), create-failure and update-failure
states. A checkbox changes only after the server stores the new state. While a
request is pending its control ignores repeat input but keeps keyboard focus,
and after a task is added both fields are cleared and focus returns to the
title field.

The list is grouped. "Today" is the browser's local date. Open tasks are shown
under Overdue (due before today), Today, Upcoming (due after today) and No
date, in that order, each group only when it has tasks. Overdue and Upcoming
are sorted by due date, earliest first (ties newest created first); Today and
No date keep the server's order, newest created first. Each group is a section
with a visible heading and its own list named by that heading. Completed
tasks, with or without a date, are in a Completed section after the groups,
newest created first. It is collapsed on every page load (the choice is not
remembered), its header is a "Completed (N)" button with `aria-expanded` and
`aria-controls`, and it is absent when no task is completed. The empty state is
shown only when there are no tasks at all. At local midnight, and when the page
becomes visible again after being hidden, "today" is recomputed and rows move
between groups without a reload. The API list order is unchanged; grouping
happens in the browser (`packages/web/src/taskGroups.ts`, date logic in
`packages/web/src/dueDate.ts`, using `Intl` and no date library).

A row with a due date shows it as text: "Due today", "Due tomorrow", "Due
yesterday", otherwise a short weekday, day and month in the browser's locale
(for example "Due Fri, Nov 20"), with the year only outside the current year.
An overdue row also shows the word "Overdue" in the destructive colour, so
overdue is not conveyed by colour alone, and the checkbox is described by that
text. A completed task shows its date without overdue marking. A 401 from a task
request returns the page to the signed-out view, except after an explicit
sign-out.

Each row has an Edit and a Delete control next to its checkbox, each named
after the task (for example `Edit "Buy oat milk"`).

- Edit turns the title into a text field, with a date field prefilled with
  the due date, a "Remove due date" control when a date is set (native date
  fields do not offer a clear button in every browser), Save and Cancel, one
  row at a time. Enter saves, and Escape anywhere in the form cancels.
  The fields apply the same title and due date rules as the add form and show
  the message under the row. Only the fields that changed are sent; if neither
  the trimmed title nor the date changed, edit mode closes without a request.
  The row shows the new title and date, and moves to its new group, only after
  the server stored them; if saving fails the row stays in edit mode with the
  typed values and an error. While a row is edited its checkbox is hidden.
- Delete asks in the row ("Delete this task?" with Confirm and Cancel) instead
  of using a browser dialog. Focus lands on Cancel, and Escape inside the
  question cancels it like Cancel does. The row disappears only
  after the server deleted the task; if that fails the row and the question
  stay and an error is shown. Deleting the last task shows the empty state.
- Focus is moved on purpose: into the field when editing starts, back to the
  row's Edit control (in its new group, if it moved) after saving or
  cancelling, to the date field after "Remove due date", back to Delete after
  cancelling a delete, and after a delete to the first control of the next row,
  else the previous row, else the new-task field. Neighbours are taken in page
  order across groups.
- A row changes group only after the server confirmed the change. Completing a
  task while Completed is collapsed removes the row from view: if focus was in
  it, focus moves to the next visible row's first control, else the previous
  row's, else the Completed toggle, and a status message says the task was
  moved to Completed (an open delete question on that row is closed).
  Completing a task while Completed is expanded, or clearing a completed task,
  keeps focus on that task's checkbox in its new position.
- When a new day (at local midnight, or when the page becomes visible again)
  moves rows to another group, focus stays on the same control of the moved
  row, and a text field being edited keeps its caret.
- Edit and Delete wait while a completion change for that task is pending, and
  so does Confirm. While a rename is being saved, Edit on the other rows waits;
  while a delete is pending, Delete on the other rows waits. A control that is
  waiting is marked `aria-disabled` and dimmed, and keeps keyboard focus.
- If the server answers 404 to a rename or delete (the task was removed
  elsewhere), the row is removed and a notice says the task no longer exists.
  A completion change answered with 404 for a task this page has already
  removed shows no error.

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

Due dates are calendar days and must not depend on the server's timezone. To
check that, run the API tests with the process in a timezone east of UTC as
well: `TZ=Pacific/Auckland pnpm --filter @tasks/api test`.

`pnpm test` runs the API integration tests and then the web component tests;
`pnpm verify` runs typecheck, tests and build. Neither needs a browser.

Each API test file creates/migrates/drops its own unique disposable
`tasks_test_*` database. They never truncate the development database. Auth
tests exercise PKCE callbacks, state and issuer checks, replay, invalid profiles,
session persistence/renewal/expiry, cookie isolation, CSRF and sign-out using a
fixture provider. Task tests cover create/list, title validation, completing and
clearing, renaming (with the create title cases reused against `PATCH`), due
dates (create, set, change and remove alone or with other fields, the invalid
cases on both routes, the range boundaries and isolation), deleting, persistence across sign-out, a new session and a second app instance
on the same database, per-user isolation, session enforcement and the origin
check. They do not prove hosted SSO.

Web component tests (`packages/web/src/*.test.tsx`) use Vitest, jsdom and
Testing Library with `fetch` stubbed. They cover the signed-out view, the task
list states, creating, completing, renaming and deleting tasks, due dates in
the add form and in edit mode, grouping and sorting, the Completed section,
date labels and overdue marking, the midnight and visibility refresh (with a
fixed clock), failures, pending states, focus targets and 401 handling. Unit
tests (`*.test.ts`) cover the date helpers and grouping. They do not run a real browser
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
sees none of the first user's tasks. Due date scenarios fix the browser clock
(`page.clock`) and timezone (`timezoneId`): creating tasks with and without
dates into their groups with overdue marking (with screenshots at a narrow and
a wide viewport attached to the test results), changing and removing a date by
keyboard and by pointer, completing a task into the collapsed Completed
section, a page left open across local midnight, and Pacific/Auckland showing
the stored date without shifting it. The configuration sets the browser's
`LANGUAGE` to `en_US`, because Chromium orders the parts of a date field by
that variable rather than by the context locale. `@playwright/test` is a dev dependency of
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

### Production status

Tasks is deployed at https://tasks.szarans.ca. The latest production deploy is
[Deploy Tasks run 43887151976](https://github.com/pior-labs/app-tasks/actions/runs/43887151976)
(successful, 2026-11-16) at revision `f9e7e479ad73451eb04103d0779a1006937f3f4c`,
which includes task creation, completion, rename and delete. The deploy applies
the app migrations, so `0000` and `0001` are applied in production. The user
confirmed the deployed application works. Earlier successful deploys were
[43622123331](https://github.com/pior-labs/app-tasks/actions/runs/43622123331)
(`107c767`, task creation and completion) and
[43052764530](https://github.com/pior-labs/app-tasks/actions/runs/43052764530)
(`4631c02`).

The evidence paragraphs below were recorded before production deployment and
describe the local checks done for each change.

Task feature verification evidence: typecheck, production builds, fifteen
disposable-database API tests (eight auth, seven task) and fifteen web component
tests passed locally. At the time, migration `0001` had been applied only to
disposable test databases, and the feature had not been checked in a real
browser or against hosted SSO.

Rename and delete verification evidence: typecheck, production builds, the API
tests (eight auth, fifteen task), 44 web component tests and the eight
end-to-end tests passed locally on Node 24 against disposable databases, with
the end-to-end suite in headless Chromium using fixture sign-in. The change
adds no migration.

Due dates verification evidence: typecheck, production builds, the API tests
(also with the process under `TZ=Pacific/Auckland`), the web component and
unit tests and the end-to-end suite passed locally on Node 24 against
disposable databases, and migration `0002` was applied to a disposable
database already at `0001` with existing rows. Migration `0002` is not yet
applied in production; the next deploy applies it.

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
was not observed. Tasks is deployed in production; see
[Production status](#production-status).

## Verified CI releases

CI publishes immutable images after validation; production deployment is manual
and selects a successful main CI run. Configure the separate
`COMPOSE_PROJECT_NAME` Actions secret and follow [deployment operations](docs/DEPLOYMENT.md)
for activation, exact run selection, persistent-data boundaries and recovery.
