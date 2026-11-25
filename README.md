# Tasks

Pior Labs Tasks. A signed-in user can create tasks, see their saved tasks,
mark a task complete or clear it again, rename a task, give a task an optional
due date and optional plain-text notes, make a task with a due date repeat,
sort tasks into lists they name (with a built-in Inbox), share a list with
the household, and delete a task. In a shared list every member can do
everything, rows say who added and completed a task, and a task can be
assigned to a member; an "Assigned to me" view gathers the tasks assigned to
the user from every shared list. Open tasks are grouped by when they are due.
Deletion is permanent: there is no archive or undo. Priorities are not
implemented.

React/Vite, Hono, PostgreSQL/Drizzle, pnpm, published
`@pior-labs/design-system`, and Better Auth application sessions. Versions are
defined in `.node-version`, `packageManager` and each package's `package.json`.
The starting source is `pior-labs/template-webapp` revision
`9b719955088ab31dd294ad84f7a9f1a0ac5a5e72`. The private GitHub repository was
generated using GitHub template generation; foundation changes are separate
commits on its generated baseline.

## Local development

Install the Node.js version in `.node-version` (fnm, mise, nodenv and asdf read it
directly) and any pnpm release; pnpm switches itself to the version in
`packageManager`. Node.js 25 and later no longer bundle Corepack. CI runs
`scripts/check_versions.py`, which fails when Dockerfiles, workflows or
`engines` disagree with those sources. From the workspace root:

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

The `auth-pior` OAuth client uses Better Auth with discovery, PKCE and
required ID-token verification: each ID token's signature, issuer, audience and
nonce are checked against the issuer and JWKS that discovery publishes. The
profile comes from authenticated UserInfo, whose subject must match the
verified ID token. Provider identities are linked by that subject; email-based
account linking is disabled. Local users, sessions, accounts and OAuth state
are persisted in Tasks' own database, alongside the task-domain `tasks` table.

`GET /api/me` requires an unexpired local session and returns only ID/name/email.
`/health` and `/api/health` are public liveness endpoints. Other API routes after
the auth boundary require a session. Sign-out revokes only the Tasks session;
provider logout is disabled. The web app starts sign-in with
`POST /api/auth/sign-in/social` and `{ "provider": "auth-pior" }`.
Cookies use the unique `tasks` prefix: `tasks.session_token` and the pinned
library's emitted `tasks.state`, with HttpOnly/SameSite=Lax and Secure on HTTPS.

Exact callbacks used by Better Auth, registered in service-auth:

- http://localhost:5173/api/auth/callback/auth-pior
- https://tasks.szarans.ca/api/auth/callback/auth-pior

## Tasks

Each row in `tasks` belongs to one app-local user (`user_id`, cascade delete)
and has a `title`, a `completed` boolean, an optional `due_date` and
timestamps. `due_date` is a nullable PostgreSQL `date` (a calendar day with no
time or timezone), added by migration `0002`; existing rows get `NULL`, and
the migration only adds the column, so an image built before it keeps working
against the migrated table. Drizzle reads and writes it in string mode, so the
server never converts it between timezones. Migration `0003` adds the repeat
columns, all nullable, so existing rows do not repeat and an image built before
it keeps working against the migrated table: `repeat_unit` (`day`, `week`,
`month` or `year`) and `repeat_every` (1 to 99), set together or both null;
`repeat_anchor`, the `date` the schedule counts from, set exactly when the task
repeats; and `repeated_from_id`, the occurrence whose completion created the
row (a unique foreign key to `tasks.id`, `ON DELETE SET NULL`). Check
constraints enforce the units, the range and that the three repeat columns are
set together. `repeat_anchor` and `repeated_from_id` are internal and not
returned. Migration `0004` adds `notes`, a nullable `text` column with the check
constraint `tasks_notes_length_check` (null, or 1 to 5000 characters as counted
by `char_length`, which counts code points); it only adds the column, so
existing rows have no notes and an image built before it keeps working against
the migrated table. Migration `0005` adds lists (see [Lists](#lists)): the
`lists` table and the nullable `tasks.list_id`; existing rows get `NULL`, which
means Inbox. Migration `0006` adds sharing, attribution and assignment (see
[Shared lists](#shared-lists)). The owner is never taken from the request: it is
the session user, or the owner of the task's list (see Shared lists), and
`user_id` is not returned. All task routes sit behind the session boundary and
return 401 without a valid session.

| Route | Request | Success |
| --- | --- | --- |
| `GET /api/tasks` | none | 200 `{ "tasks": [...] }`, the session user's own tasks plus every task in a shared list, newest first |
| `POST /api/tasks` | `{ "title": string, "notes"?: string or null, "dueDate"?: string or null, "repeat"?: object or null, "listId"?: number or null, "assigneeId"?: number or null }` | 201 `{ "task": {...} }`; the title is trimmed, 1 to 200 characters |
| `PATCH /api/tasks/:id` | any of `{ "title": string }`, `{ "notes": string or null }`, `{ "completed": boolean }`, `{ "dueDate": string or null }`, `{ "repeat": object or null }`, `{ "listId": number or null }`, `{ "assigneeId": number or null }`, together or alone, plus an optional `"today"` when completing | 200 `{ "task": {...}, "nextTask": {...} or null, "removedTaskId": number or null }` |
| `DELETE /api/tasks/:id` | none | 204 with no body; the task is removed permanently |

A task is `{ id, title, listId, notes, completed, dueDate, repeat, createdById, completedById, assigneeId, createdAt, updatedAt }`,
where `listId` is the id of a list the user can see (their own or a shared
one) or `null` for Inbox, `createdById`, `completedById` and `assigneeId` are
user ids or `null` (see [Shared lists](#shared-lists)),
`notes` is a string or `null`, `dueDate` is a `"YYYY-MM-DD"` string or
`null` and `repeat` is
`{ "every": n, "unit": "day" | "week" | "month" | "year" }` or `null`. Errors are
`{ "error": code, "message": text }` with stable codes: 400 `invalid_json`,
`invalid_title`, `invalid_notes`, `invalid_completed`, `invalid_due_date`,
`invalid_repeat`, `invalid_list`, `invalid_assignee`, `invalid_today`, `invalid_update` or `invalid_task_id`; 403
`forbidden_origin` when a `POST`/`PATCH`/`DELETE` does not carry the application
origin (`BETTER_AUTH_URL`) in `Origin`; 404 `task_not_found` for an id that does
not exist, was already deleted or is another user's and not in a shared list
(the cases are indistinguishable).

`PATCH` changes only the fields that are sent. A title follows the same rules
as on create, from one shared definition in `packages/api/src/tasks.ts`. A body
with none of `title`, `notes`, `completed`, `dueDate`, `repeat`, `listId` and
`assigneeId` (an empty object, a body with only `today`, or anything that is
not an object) is 400 `invalid_update`, and its message names all seven; before
renaming existed such a body was answered with `invalid_completed`. If any
field is invalid nothing is changed, and the first invalid field (in the order
title, notes, completed, due date, repeat, list, assignee) decides the code.
Other fields, such as `userId`, `createdById` or `id`, are ignored. Every
successful update sets `updatedAt`; `createdAt`, and so the list order, never
changes. Every read and write uses the access rule (see
[Shared lists](#shared-lists)). A `PATCH` locks the task's row (and then its
list) and runs in one transaction with the next occurrence it creates or
removes, so concurrent changes to one task run one after another.

Title rules, applied by the API and mirrored by the forms: the title is trimmed;
a title with nothing visible (only whitespace, control characters or invisible
characters such as a zero width space) is rejected like an empty one; a title
containing a null character is rejected because PostgreSQL cannot store it; the
200 limit counts Unicode code points, so an emoji is one character. Visible
titles are stored unchanged apart from trimming.

Notes rules, from one shared definition used by `POST` and `PATCH`: notes are
optional plain text, never interpreted as Markdown or HTML. They are trimmed at
the ends only; line breaks and spacing inside are stored exactly as sent.
Notes with nothing visible after trimming (the title rule), `""` and `null` are
all stored as `null`, which on `PATCH` clears them; a missing `notes` on create
means none and on `PATCH` leaves them unchanged. More than 5000 characters
(Unicode code points, so an emoji is one), a null character or anything that is
not a string or `null` is 400 `invalid_notes` and nothing changes. The forms
apply the same rules.

Due date rules, from one shared definition used by `POST` and `PATCH`: a due
date is a string in the exact form `YYYY-MM-DD` that is a real calendar date
(`2026-02-30` and `2026-13-01` are refused, `2028-02-29` is accepted) from
`2025-01-01` through `2100-12-31`, both included, or `null` for no due date.
Past dates in that range are allowed. A missing `dueDate` on create means no
due date. Anything else (another format, a day that does not exist, a date
outside the range, a number or another type) is 400 `invalid_due_date` and
nothing is created or changed. The forms apply the same range.

Repeat rules, from one shared definition used by `POST` and `PATCH`: a repeat
is an object with exactly an integer `every` from 1 to 99 and a `unit` of
`day`, `week`, `month` or `year`, or `null` for "does not repeat" (a missing
`repeat` on create means none). Anything else (a missing or extra key, `every`
0, 100, a fraction or not a number, another unit, or not an object) is 400
`invalid_repeat` and nothing changes. A repeat needs a due date: a repeat on a
task without one, or removing the date of a repeating task without also
sending `"repeat": null`, is also 400 `invalid_repeat`. The schedule is fixed
to the calendar. It counts from `repeat_anchor`, which is set to the due date
when a repeat is set or changed and whenever the due date of a repeating task
changes, so moving a task realigns its schedule. Occurrences are the anchor
plus whole intervals; months and years keep the anchor's day of month, clamped
to the last day of shorter months, so a task anchored on January 31 is due
February 28 (29 in a leap year), then March 31, and a yearly task on February
29 is due February 28 in common years. Edits apply to the row they are made on
and to occurrences created from it later.

Completing a repeating task (a `PATCH` that changes `completed` from false to
true, after applying the other fields in the same body) creates the next
occurrence with the same owner: the same title, notes, list, repeat and
assignee (as stored by that same `PATCH`) and the original's `createdById`,
open (`completedById` null), and the due date
of the earliest occurrence that is after the current due date and not before
"today". Done early, that is the occurrence after the due date; done late,
missed occurrences are skipped, so overdue repeats do not pile up. It is
returned as `nextTask` and linked by `repeated_from_id`. If that date would be
after `2100-12-31`, or an occurrence created from this task already exists, no
occurrence is created and `nextTask` is `null`; the unique `repeated_from_id`
makes "one next occurrence per completed occurrence" a database guarantee, also
for concurrent requests. "Today" is the user's local date: a completing `PATCH`
may send `"today": "YYYY-MM-DD"`, accepted only within one day of the server's
UTC date (which covers UTC-12 to UTC+14), else 400 `invalid_today` and nothing
changes; without it the server uses its UTC date. `today` is ignored by other
requests. Un-completing (`completed` from true to false) deletes the occurrence
created from this task if it is still open, even if it was renamed or re-dated,
and returns its id as `removedTaskId`; one that was completed meanwhile is
kept, and completing the task again then creates no second copy. Every other
`PATCH` returns `nextTask` and `removedTaskId` as `null`. Deleting a task
deletes only that row; its next occurrence stays, with `repeated_from_id`
cleared. Date arithmetic is plain code in `packages/api/src/repeat.ts`.

### Lists

Each task is in Inbox or in one list the user named, such as "Home" or
"Errands". Inbox is not stored: `tasks.list_id` `NULL` means Inbox, so every
user has one, existing tasks are in it, and it cannot be renamed or deleted.
Each row in `lists` belongs to one app-local user (`user_id`, cascade delete,
so deleting a user deletes their lists) and has a `name` and timestamps.
Migration `0005` adds the table, the nullable `tasks.list_id` (indexed) and a
composite foreign key `tasks_list_fk` from `(list_id, user_id)` to
`lists (id, user_id)`, so the database itself refuses a task in another user's
list, and refuses to delete a list that tasks still point at. It is additive,
so an image built before it keeps working against the migrated tables (its new
tasks land in Inbox). `lists_name_length_check` limits names to 1 to 50
characters (`char_length`, code points) and the unique index
`lists_user_id_name_idx` on `(user_id, lower(name))` makes names unique per user
ignoring letter case. The API checks the stricter rule, a name's fold (below),
and keeps this index as a backstop.

| Route | Request | Success |
| --- | --- | --- |
| `GET /api/lists` | none | 200 `{ "lists": [...] }`, the session user's lists plus every shared list, oldest first (ties by id) |
| `POST /api/lists` | `{ "name": string }` | 201 `{ "list": {...} }`, never shared |
| `PATCH /api/lists/:id` | `{ "name": string }`, `{ "shared": boolean }`, or both | 200 `{ "list": {...} }` |
| `DELETE /api/lists/:id` | none | 200 `{ "movedTaskIds": [...] }`, the ids of the list's tasks, which are now in Inbox |

A list is `{ id, name, shared, ownerId, createdAt, updatedAt }`, where
`ownerId` is the id of the user who created it. The routes sit behind the same
session boundary and origin check as the task routes. Errors: 400
`invalid_json`, `invalid_list_name`, `invalid_shared` (a `shared` that is not
`true` or `false`), `invalid_list_update` (a `PATCH` body with neither `name`
nor `shared`, or that is not an object) or `invalid_list_id`; 403
`forbidden_origin`; 404 `list_not_found` for an id that does not exist, was
deleted or is another user's unshared list (indistinguishable); 409
`duplicate_list_name` or `list_limit_reached`. In a `PATCH` the first invalid
field (name, then shared) decides the code, and nothing changes.

Name rules, from one shared definition used by `POST` and `PATCH`, are those of
titles with a limit of 50: trimmed, at least one visible character, no null
character, at most 50 Unicode code points. Names compare by their fold,
which is what a person would see: Unicode NFKC (fullwidth and other
compatibility forms become their plain letters), any run of white space (a
no-break space, repeated spaces) as one space, invisible characters (such as a
zero width space, joiners, direction marks or a soft hyphen) dropped, NFKC
again (so an invisible character between a letter and its accent does not make
a second "Café"), then trimmed and lowercased. Letters from other scripts that
only look Latin (a Cyrillic "І", say) are not folded. A name whose fold is
"inbox", "all tasks" or "assigned to me" is reserved, so a list can never look
like a built-in view; names that only contain the words, such as "Inbox zero"
or "Assigned to me later", are allowed. A list stored with a name before it was
reserved keeps it, loads and shows as before, and can be renamed away.
Anything else is 400 `invalid_list_name` and nothing changes. A name with the
same fold as another of the owner's lists is 409 `duplicate_list_name` (also
when another member renames a shared list: the owner's lists count, not
theirs);
renaming a list to another form of its own fold is allowed, and two users may
have lists with the same name. Names are stored as typed. The database's
unique index on `lower(name)` stays as a backstop: for a few letters
PostgreSQL's `lower()` and the fold differ (it turns a dotted capital I into a
plain i), and a name only the index refuses is 409 `duplicate_list_name` too.
So "İstanbul" and "i̇stanbul" (an i with a combining dot) share a fold and
cannot both exist, and "istanbul" next to "İstanbul" is refused by the index.
Lists stored before the fold check that share a fold stay, and each can keep
its own name. A user can have at most 50 lists, so the tab row stays usable;
one more is 409 `list_limit_reached`. Creates and renames for one user run one
after another, so parallel requests cannot pass the limit or add two names
with one fold.

Deleting a list never deletes a task. In one transaction it moves every task
in the list, open and completed, to Inbox (refreshing their `updatedAt`) and
deletes the list; a shared list's tasks go to the Inbox of whoever added each
one (see [Shared lists](#shared-lists)). It locks the list's tasks and then the list, so a task being
added to it or moved into it at the same moment either finishes first and is
moved to Inbox, or fails afterwards.

A task's `listId` follows one shared definition used by `POST` and `PATCH`: a
positive integer or `null`. Missing or `null` on create means Inbox; on `PATCH`
it moves the task, and a missing `listId` leaves it where it is. Anything that
is not a positive integer or `null`, and the id of an unknown, deleted or
another user's unshared list, is 400 `invalid_list` (the same answer for all of
these) and nothing changes. The route checks the list with it locked, and the
foreign key backs that up, so a list deleted at the same moment cannot slip
through and never causes a 500. A transaction that
PostgreSQL ends as a deadlock victim (a list delete racing a task update) is
retried, up to three attempts. Lists are not filtered on the server:
`GET /api/tasks` returns every task with its `listId` and the browser filters.

The signed-in page uses the Pior Labs shell shared with the other apps: the
design system's drifting mesh behind a glass rail, with the content beside it.
The rail holds the views and lists, then a "New list" button (its form opens
in the rail) and, when there are lists, a "Manage lists" button (its panel
opens in the main column), and at the end an account control whose menu shows
who is signed in, the theme choice and "Sign out". The views are "All tasks",
"Inbox", "Assigned to me" (always, also without shared lists) and the user's
lists in creation order. They are a tablist named
"Lists" with automatic activation: arrow keys (Left/Right or Up/Down, wrapping
at the ends), Home and End move to a tab and select it, and only the selected
tab is in the Tab order; a "Skip to tasks" link comes before it. The add form
and the task list are the selected tab's tabpanel. The
selected view is kept in the URL as `?list=all`, `?list=inbox`,
`?list=assigned` or `?list=<id>`, so a reload keeps it; with no parameter, or an id that is not one
of the user's lists, the view is "All tasks", which keeps every task in view by
default. On a narrow screen the rail is a bar above the content and the tabs
get a row of their own that scrolls sideways inside itself, without scrolling
the page. The sign-in screen offers the theme choice too.

"Inbox" shows the tasks with no list, a list's tab shows its tasks, "All
tasks" shows every task, and "Assigned to me" shows the tasks whose assignee is
the user, from every shared list they can see (their own and other members'),
open and completed. It is a filter in the browser over `GET /api/tasks`; tasks
in Inbox or in a list that is not shared never show there, since only a task
in a shared list has an assignee. Each view keeps the grouping, the Completed
section and the ordering described below, and has its own empty state ("No
tasks in Errands yet."; "All tasks" keeps "No tasks yet. Add your first one
above."; "Assigned to me" says "No tasks are assigned to you yet: tasks
assigned to you in shared lists show here.").
In "All tasks" and "Assigned to me", a row in a named list shows the list's
name as a muted label under the due date line (read as "List: Errands"); Inbox
rows show none, and the label is not part of the checkbox's description. A
task added while a named list is selected is created in it (`listId` is sent);
in "All tasks", Inbox and "Assigned to me" the add request sends no
`listId`. The title field's placeholder names the destination ("Add to
Errands", "Add to Inbox"). A task added from "Assigned to me" is in Inbox, so
it does not show there, and a status message says `Added "Milk" to Inbox.`

"New list" reveals a "List name" field with "Create list" and Cancel. Enter
creates the list, adds its tab, selects it and focuses it; Escape or Cancel
closes the field without a request and returns focus to "New list". The field
checks the server's rules first (length, visible characters, reserved names
and a duplicate of a loaded list, with the same fold as the server) and shows
those errors, and
`invalid_list_name`, `duplicate_list_name` and `list_limit_reached` from the
server, on the field with `aria-invalid` and `aria-describedby`. "Manage lists"
shows each list with Rename and Delete. Rename works like a task rename: Enter
saves, Escape cancels, errors show on the field, and the tab and the labels
change once the server stored the name. Delete asks in the row, naming the
list and how many loaded tasks will move ("Delete Errands? Its 3 tasks will
move to Inbox."); after the server deleted it the tab goes, its tasks show in
Inbox, and if it was selected the view and the URL switch to Inbox. Focus moves
to the next list's Rename, else the previous one's, else "New list".

The edit row has a "List" select (named `List for "<title>"`, with Inbox and
every list) after the date and repeat controls and before the notes, so title
to date is still one Tab. It is sent only when it changed. A task moved out of
the selected list or Inbox leaves the view: a status message says where it
went (`Moved "Milk" to Errands.`) and focus moves as after a delete. In
"Assigned to me" a save that leaves the task assigned to someone else or to
nobody, or moves it out of its shared list, removes it the same way, and the
message says what happened (`"Milk" is now assigned to Household Two.`,
`"Milk" is no longer assigned to you.`, `Moved "Milk" to Inbox, so it is no
longer assigned to you.`); a move to another shared list keeps it. If the
server answers `invalid_list` (the list was deleted meanwhile), the error shows
on the select and the lists are loaded again, so the select no longer offers
the missing list. If a list was deleted in another tab, an add to it, or a
rename or delete of it, shows a notice, drops its tab (its tasks show in Inbox)
and switches to Inbox if it was selected; an add keeps the typed task. Lists
that fail to load show an error with a "Load lists again" button while the
tasks still work in "All tasks". A 401 from any list request returns the page
to the signed-out view.

### Shared lists

The household is every Tasks user: everyone who has signed in to Tasks at
least once (Auth has no groups). A list's owner, or any member who can see it,
can mark it "Shared with household"; every member then sees it and its tasks
next to their own lists and can do everything with them that the owner can:
add, edit, complete, reopen, move and delete its tasks, and rename, unshare or
delete the list. Inbox and single tasks cannot be shared, and a member who
signs in for the first time sees every list shared before.

Migration `0006` is additive. It adds `lists.shared` (boolean, default
`false`, so existing lists stay private) with the partial index
`lists_shared_idx` for the shared-list lookups, and three nullable columns on
`tasks`, each a foreign key to `users` with `ON DELETE SET NULL`, so deleting a
user clears them on other users' tasks instead of deleting those:
`created_by_id` (who added the task; backfilled from `user_id` for existing
rows, by a statement added by hand to the generated SQL), `completed_by_id`
(who completed it; null while open, and for tasks completed before `0006`) and
`assignee_id`. An image built before `0006` keeps working against the migrated
database: it ignores the new columns, shows no shared lists of others, and its
new tasks have no `created_by_id` (shown without attribution).

The access rule is one definition (`packages/api/src/access.ts`) used by every
list and task route: a user can read and write a list they own or any shared
list, and a task whose `user_id` is theirs or that is in a shared list.
Anything else stays 404 `list_not_found` / `task_not_found`, or 400
`invalid_list` as a target list, exactly as for something that does not exist.
A task in a list always has the list owner's `user_id` (`tasks_list_fk` still
refuses anything else): a task another member adds to someone's shared list is
stored with the owner's `user_id` and the adder's `created_by_id`. Moving a
task into a list gives it to that list's owner; moving it to Inbox gives it to
the member who moved it, so it disappears for the others. `createdById` never
changes on a move.

| Route | Request | Success |
| --- | --- | --- |
| `GET /api/members` | none | 200 `{ "members": [{ "id": number, "name": string }] }`, every Tasks user, by name then id; never email addresses |

- Sharing and unsharing: `PATCH /api/lists/:id` with `{ "shared": true }` or
  `false`. Unsharing, by anyone, returns the list and all its tasks, also those
  other members added, to the owner only, and clears their assignees; a member
  who unshares someone else's list loses access to it.
- Names: duplicates and the 50-list limit count the owner's lists, so two
  members may each have a "Groceries", one of them shared. The shared marker
  tells the tabs apart.
- Deleting a shared list moves each task, open and completed, to the Inbox of
  whoever added it (the list owner when that is unknown) and clears its
  assignee; `movedTaskIds` names them all. An unshared list's tasks go to the
  owner's Inbox.
- Attribution: `createdById` is the session user on create; `completedById`
  is the session user when a `PATCH` changes `completed` from false to true,
  unchanged by other updates, and null after reopening.
- Assignment: `assigneeId` on `POST` and `PATCH` is a member's id or `null`
  (nobody). It is accepted only when the task ends up in a shared list after
  the same request; anywhere else, for an id that is not a Tasks user, or a
  value that is not a positive integer or `null`, the answer is 400
  `invalid_assignee` and nothing changes. A task that leaves a shared list
  (moved out, unshared or deleted) loses its assignee. A `PATCH` with only
  `assigneeId` is a valid update.
- Concurrency: a task update locks the task and then its list (`FOR SHARE`)
  and checks access again on the locked list, so a member who just lost
  access cannot still change it; unsharing and deleting lock the list's tasks
  and then the list. Adds, moves and edits racing a delete or an unshare
  answer `invalid_list` or 404, or land in Inbox, never 500.

In the web app a shared list's tab shows a two-people icon after its name,
and its accessible name ends in "(shared)" ("Groceries (shared)"); the List
select names it the same way. "Manage lists" offers "Share with household" or
"Stop sharing" next to Rename and Delete for every list, says "Shared with
household" under the user's own shared lists and "Shared by <owner>" under
other members'. Sharing and stopping sharing one's own list send the request
at once; stopping sharing someone else's list first asks in the row ("Stop
sharing Groceries? It goes back to Household Two with all its tasks, and you
will lose access to it."), with focus on Cancel and Escape to cancel; after
the server stored it the tab and its tasks go, a status message says so, and a
selected view switches to Inbox. The delete question for a shared list says
"Its 3 tasks will return to the Inbox of whoever added them." Errors show
above the managed lists, as for a failed delete.

A row in a shared list, in the list's own view and in "All tasks", shows a
muted line with "Added by <name>" when someone else added it, "Done by <name>"
when someone else completed it, and "Assigned to you" or "Assigned to <name>".
A member missing from `/api/members` (deleted, or the members failed to load)
is not named. Rows in Inbox and in unshared lists look as before. When the
edit row's List choice is a shared list, an "Assigned to" select (named
`Assigned to, for "<title>"`, with Nobody, "Me (<name>)" and every other
member) follows the List select; it is sent only when it changed. Choosing a
list that is not shared removes the select and clears the choice, as the
server does.

Live refresh is polling (no websockets or server-sent events): while signed
in, the page fetches the lists, tasks and members again when the window gains
focus, when the page becomes visible, and every 30 seconds while it is
visible, one refresh at a time. A refresh shows what other members added,
changed, completed or deleted, and their list renames, shares and deletes. It
never touches the add form, the row being edited or asking to confirm a
delete, or focus: a refresh that overlaps a change the page is making is
dropped and the next trigger tries again, and a focused control whose row
moves to another group keeps focus in its new place. If the selected list is
gone, the view switches to Inbox with a notice. In "Assigned to me" a refresh
adds a task another member assigned to the user and removes one they
unassigned, moved out of its shared list, unshared or deleted (with its list),
with the same focus rules; the view itself never switches away. An open edit
row or delete question there stays, as in other views, unless its list was
deleted or stopped being shared: then it closes with a notice (`"Milk" is no
longer assigned to you, because its list was deleted or is no longer
shared.`). The same happens when the user stops sharing or deletes their own
list in Manage lists, and when they stop sharing someone else's list (`"Milk"
is no longer shared with you.` after the list's notice); focus stays in
Manage lists. In every other view, stopping sharing someone else's list,
deleting a list, or a Manage lists change that finds the list gone closes an
open edit row or delete question on a task that is no longer the user's, so it
does not show again if the task comes back. The notice names the task
(`"Milk" is no longer shared with you.`), after the list's notice when there is
one; a successful delete has no list notice, so it is only that sentence. One
on a task that moves to the user's Inbox stays open. A change that finds
someone else's list gone cannot tell whether it was deleted or stopped being
shared, so it keeps the user's own tasks from it in Inbox until the refresh it
starts: a task that refresh (or the next one that applies) does not return
leaves, and an open edit row or delete question on it closes with the same
notice. A 401 returns to the
signed-out view; any other failure is silent and retried on the next trigger.
Saving an edit of a task another member deleted meanwhile shows the usual "no
longer exists" notice.

The signed-in page shows an add-task form (a title, an optional "Due date"
field, a "Repeats" control and an "Add notes" toggle) and the task list, with distinct
loading, empty, load-failure (with retry), create-failure and update-failure
states. A checkbox changes only after the server stores the new state. While a
request is pending its control ignores repeat input but keeps keyboard focus,
and after a task is added the fields are cleared and focus returns to the
title field.

"Repeats" is a native select with "Does not repeat", "Daily", "Weekly",
"Monthly", "Yearly" and "Custom"; "Custom" reveals an "Every" number field (1 to
99) and a unit select (days, weeks, months, years), starting from the task's
stored repeat (every 1 week in the add form or for a task that did not repeat),
not from presets passed on the way. It is available only while
the form has a due date: without one the select (and any Custom field) is
`disabled`, so it is dimmed, cannot be opened or changed and is skipped by Tab,
and it is described by the visible hint "Set a due date to repeat"; removing
the date resets it to "Does not repeat" (a partly typed date does not). While
a request is pending it is locked with `aria-disabled` like the other pending
controls, so it keeps keyboard focus. The edit row has the same control, named after the task. A Custom
interval outside 1 to 99 is refused next to the control without a request, and
an `invalid_repeat` from the server is shown the same way.

"Add notes" is a button with `aria-expanded`, after "Add task" in Tab order, so
the order of the other fields is unchanged. It shows a "Notes" text area below
it. In the text area Enter starts a new line and Ctrl+Enter (Cmd+Enter on a
Mac) adds the task. Notes are sent only when the area is shown and they have
something visible after trimming, so a task without notes is still sent as
`{ "title": ... }`; hiding the area again keeps the typed text for later (also
across an add) but does not send it. Notes over 5000 characters or with a null character are
refused next to the field without a request (`aria-invalid` and
`aria-describedby` point at the message), and an `invalid_notes` from the
server is shown the same way. After a task is added the notes are cleared and
the area is hidden again.

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
text. A repeating row, open or completed, also shows its repeat after a dot:
"Repeats daily", "Repeats weekly", "Repeats monthly", "Repeats yearly" or, for
example, "Repeats every 3 days". A completed task shows its date without
overdue marking. Notes are shown under the title and date as plain text with
their line breaks, lined up with the title, and in muted text on a completed
task; they are not part of the checkbox's description. Short notes are shown in
full. Notes taller than 10rem (about six lines) are capped at that height with
a vertical scroll bar, and only then the notes box is a region named
`Notes for "<title>"` that Tab stops on, so keyboard users can scroll it. While more text is below, the bottom 2rem of the
box fades out (a `data-notes-more` attribute), which cues the overflow where scroll bars
are hidden until used; the fade goes when the box is scrolled to the end and is never shown for
notes that fit. A 401 from a task
request returns the page to the signed-out view, except after an explicit
sign-out.

Each row has an Edit and a Delete control next to its checkbox, each named
after the task (for example `Edit "Buy oat milk"`).

- Edit turns the title into a text field, with a date field prefilled with
  the due date, a "Remove due date" control when a date is set (native date
  fields do not offer a clear button in every browser), the List select (see
  [Lists](#lists)), Save and Cancel, one row at a time. Enter saves, and Escape anywhere in the form cancels.
  A full-width "Notes" text area, named `Notes for "<title>"` and prefilled
  with the notes, comes after the date and repeat controls and before Save; in
  it Enter starts a new line and Ctrl+Enter (Cmd+Enter) saves, and it is
  read-only while saving.
  The fields apply the same title, due date and notes rules as the add form and
  show the message under the row. Only the fields that changed are sent (notes
  are compared as they would be stored, and emptied notes are sent as `null`);
  if none of the trimmed title, the notes, the date and the repeat changed, edit
  mode closes without a request. Removing the date of a repeating task sends `"repeat": null` with
  it. The row shows the new title, notes, date and repeat, and moves to its new group,
  only after
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
- Ticking always sends the browser's local date as `today`. Ticking a
  repeating task moves it to Completed and adds the `nextTask` from the server
  to its group; the status message says when it is next due (for example
  `"Water the plants" is next due Wed, Nov 26.`, in the words of the row
  labels), and focus moves to the new occurrence's checkbox whether or not
  Completed is expanded. If no occurrence was created, the status message says
  why: its date would be after December 31, 2100, or the next occurrence
  already exists (it was kept when the task was un-ticked, or another tab
  completed the task first). Un-ticking an occurrence whose next occurrence the server removed
  (`removedTaskId`) removes that row too, with a status message, and focus
  follows the un-ticked row.
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

Due dates are calendar days and repeat schedules use the server's UTC date, so
neither may depend on the server's timezone. To check that, run the API tests
with the process in a timezone east of UTC as well:
`TZ=Pacific/Auckland pnpm --filter @tasks/api test`.

`pnpm test` runs the API integration tests and then the web component tests;
`pnpm verify` runs typecheck, tests and build. Neither needs a browser.

Each API test file creates/migrates/drops its own unique disposable
`tasks_test_*` database. They never truncate the development database. Auth
tests exercise PKCE callbacks, state and issuer checks, ID-token verification
(unsigned, wrong key, issuer, audience, nonce, expiry and subject), replay,
invalid profiles,
session persistence/renewal/expiry, cookie isolation, CSRF and sign-out using a
fixture provider. Task tests cover create/list, title validation, completing and
clearing, renaming (with the create title cases reused against `PATCH`), due
dates (create, set, change and remove alone or with other fields, the invalid
cases on both routes, the range boundaries and isolation), notes
(`packages/api/test/notes.test.ts`: trimming, kept line breaks, empty and
invisible notes stored as null, the 5000 code point limit, invalid values on
both routes, the response shape, isolation between users, the copy to the next
occurrence, and migration `0004` applied to a database with existing rows plus
the database check constraint), deleting, persistence across sign-out, a new session and a second app instance
on the same database, per-user isolation, session enforcement and the origin
check. Repeat tests (`packages/api/test/repeat.test.ts`) pin the server clock
through the fixture and cover setting, changing and stopping a repeat with the
anchor checked by SQL, every invalid repeat and the no-due-date cases, the next
occurrence when completed early, on time, late by less than one interval and by
several, daily, weekly, every 2 weeks, monthly and yearly, month ends across
February, April and a leap year, a yearly February 29, a moved due date, the
2100-12-31 limit, the `today` window edges and its absence (the server's UTC
date), undo, a kept completed successor, parallel completions creating exactly
one successor, delete with a successor, and isolation between users. List
tests (`packages/api/test/lists.test.ts`) cover name rules on both routes
(trimming, invisible names, the 50 code point limit, null characters, reserved
names by their fold, non-text bodies), duplicates by fold per user including
parallel creates and renames and lists stored before the check, the
list order and shapes, the 50-list limit including parallel creates, malformed
JSON and ids, deleting a list with open and completed tasks, ownership and the
origin check, `listId` on every task response, moves, invalid, unknown,
deleted and foreign list ids, the composite foreign key, deletes racing adds,
moves and completions without a 500, the next occurrence keeping its list, and
migration `0005` applied to a database with existing rows plus the database
constraints and the user cascade. Sharing tests
(`packages/api/test/sharing.test.ts`) cover migration `0006` on a database
with existing rows (the backfill, `tasks_list_fk`, and user deletes clearing
the new columns), `/api/members` (shape, order, no email, 401), sharing and
unsharing with and without a name and the bad bodies, what each member sees
and the unchanged 404s for unshared lists, a first sign-in after sharing,
every member's rights on a shared list with duplicate names checked against
the owner's lists, ownership on moves, deleting a shared list into each
creator's Inbox, deletes and unshares racing adds, moves and completions
without a 500, attribution including the next occurrence, every assignment
rule, and the task shape. They do not prove hosted SSO.

Web component tests (`packages/web/src/*.test.tsx`) use Vitest, jsdom and
Testing Library with `fetch` stubbed. They cover the signed-out view, the task
list states, creating, completing, renaming and deleting tasks, due dates in
the add form and in edit mode, grouping and sorting, the Completed section,
date labels and overdue marking, the midnight and visibility refresh (with a
fixed clock), repeats in the add form and in edit mode (presets, Custom,
disabled without a date and enabled with one, the `aria-disabled` lock while
pending, reset when the date is removed, changed fields
only, inline errors, row labels), ticking and un-ticking repeating tasks with
their status messages and focus, the `today` sent with a fixed clock, notes in
the add form (the toggle, Ctrl/Cmd+Enter, bodies, limits, server errors), in
edit mode (prefill, changed notes only, null when emptied, Escape, read-only
while saving, errors) and in rows (plain text, muted when completed, the
scroll region only for overflowing notes), lists (the tablist roles and
keyboard, the view in the URL and its fallback, filtering and labels per view,
empty states, add bodies per view, creating, renaming and deleting lists with
their errors and focus, the List select and moves out of a view, lists deleted
elsewhere, a lists load failure and 401s), shared lists (the tab marker,
sharing and stopping sharing from Manage lists with the question for someone
else's list, the delete wording, row labels, the "Assigned to" select and its
request bodies, and live refresh: focus, visibility and the 30-second timer,
merging another member's changes, keeping drafts, the edit row, pending
changes and focus, a vanished selected list, silent failures and a 401),
failures, pending states, focus targets and 401 handling. Unit
tests (`*.test.ts`) cover the date helpers, grouping and the repeat labels and
form values. They do not run a real browser
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
the stored date without shifting it. Repeat scenarios create a weekly task and
complete it on time, early and late by more than one interval (no overdue
pile-up), with the next occurrence in the right group and focused (with
screenshots at a narrow and a wide viewport); un-tick a completed occurrence to
remove the next one; set a custom "every 2 weeks" repeat and stop it with the
keyboard only; set and reset a repeat in the edit row by pointer; complete a
monthly task on the 31st across month ends; and, just after local midnight in
Pacific/Auckland, check that the local date is sent as `today`. Further
scenarios check that without a due date the Repeats select is disabled, dimmed
and skipped by Tab and becomes enabled once a date is set (with screenshots at
a narrow and a wide viewport), that arrowing from Weekly to Custom starts at every 1 week,
that rapid repeated ticks complete once and create one next occurrence, that a
page left open across local midnight sends the new date, and that the local
date is accepted at UTC+14 and UTC-12. Notes scenarios add a task with
multi-line notes through the "Add notes" toggle and see them after a reload;
edit, cancel and clear notes with the keyboard only; check that a long note is
capped in a focusable, named scroll region that the keyboard scrolls while a
short one is not, without horizontal scrolling at 390px (with screenshots); and
check that the next occurrence of a repeating task shows the same notes.
Lists scenarios (`packages/e2e/tests/lists.spec.ts`) create lists and switch
between them with the keyboard only; add tasks in a named list and in "All
tasks" and see them in the right views after a reload, with the URL keeping the
view; move a task between lists from the edit row; rename a list and delete one
with tasks, checking the confirmation count and the tasks in Inbox; check that
a second user sees none of the first user's lists; check that a repeating
task's next occurrence stays in its list; and check at 390px that the tab row
scrolls sideways without a page scroll (with screenshots). Sharing scenarios
(`packages/e2e/tests/sharing.spec.ts`) sign in Household One and Household
Two in separate browser contexts: One shares a list and Two sees it after a
reload and through a live refresh without one, adds a task that One sees as
"Added by Household Two", completes One's task ("Done by Household Two") and
sees "Assigned to you" after One assigns it; an unshared list stays invisible
to Two; Two renames and stops sharing One's list and loses it while One keeps
it with every task; Two stops sharing One's list with a delete question open in
All tasks, and when One shares it again the task is back without the question; Two
acts on One's list after One stopped sharing it or deleted it, and Two's own
task with a delete question leaves or stays and deletes accordingly;
deleting a shared list sends each task to its creator's Inbox; and the share toggle and the "Assigned to" select work by keyboard, with
the shared tab fitting a 390px screen (with screenshots). The page clock is
installed so a test can jump to the next 30-second refresh. Because the API
checks `today` against its own date, the test API server
(`packages/api/test/e2e-server.ts`) has a test-only `PUT /e2e/clock` route, and
each scenario that fixes the browser clock sets the API clock to the same
moment. It also has a test-only `POST /e2e/reset` route that deletes every
list and task (users and sessions stay). Every spec imports `test` from
`packages/e2e/tests/fixtures.ts`, which resets the clock and the data before
each test, so a test sees only what it creates, needs no clean-up, and the
spec files can run in any order. A new spec file must import `test` from
there too. The configuration sets the browser's
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
Configure the required `PRODUCTION` environment variable `DEPLOY_DIR=/opt/docker/app-tasks`,
GitHub Packages access for this repository, and the runner before dispatch.

Set these `PRODUCTION` environment secrets:

- `COMPOSE_PROJECT_NAME`: `tasks` for a new project.
- `CENTRAL_AUTH_CLIENT_SECRET`: the same private value as Auth's `TASKS_CLIENT_SECRET`.
- `BETTER_AUTH_SECRET`: a separate stable application session secret, at least 32 characters.

Public runtime configuration has versioned production defaults in
`scripts/deploy.py`, with optional `PRODUCTION` environment variable overrides. See the complete
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

Recurring tasks verification evidence: typecheck, production builds, the API
tests (also with the process under `TZ=Pacific/Auckland`), the web component
and unit tests and the end-to-end suite passed locally on Node 26 against
disposable databases, and migration `0003` was applied to a disposable database
already at `0002` with existing rows. Migration `0003` is not yet applied in
production; the next deploy applies it.

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
`COMPOSE_PROJECT_NAME` `PRODUCTION` environment secret and follow [deployment operations](docs/DEPLOYMENT.md)
for activation, exact run selection, persistent-data boundaries and recovery.
