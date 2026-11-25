# 0001: MCP endpoint with member bearer tokens

Status: Accepted
Decision date: 2026-11-24
Affected repositories: app-tasks

## Context

AI agents, and later the household chatbot, should be able to use Tasks the
way a member does: "Add for tomorrow to buy broccoli" should end with an Inbox
task due on the household's tomorrow that the member sees in the web app. The
workspace convention is that an application-owned MCP interface reuses the
application's logic (workspace `docs/conventions.md`). Cookbook already runs a
private HTTP MCP for ChatGPT desktop, authorized by a configured-member bearer
credential ([Cookbook ADR 0014](https://github.com/pior-labs/app-cookbook/blob/main/docs/DECISIONS.md#0014---opt-in-private-http-mcp-with-a-configured-member-credential)),
and deferred OAuth through service-auth. The chatbot integration is further
out, so the user chose member tokens now, structured so OAuth can replace them.

## Decision

**One endpoint for every member, authorized by member bearer tokens.** Tasks
serves MCP at `POST /api/mcp`, inside the existing API container, as stateless
Streamable HTTP with JSON responses (no sessions, no server push; GET and
DELETE answer 405). Each token acts as the member named by its configuration
entry; identity comes only from the token, and no tool takes a user, owner or
email argument. The server keeps only SHA-256 hashes, in `TASKS_MCP_TOKENS`
(`<member email>:<sha256 hex>` entries, several per email allowed for
rotation). Tokens are compared by hash in constant time. The email is resolved
to a Tasks user on every request, so a member who first signs in after a
deploy works without a restart. A malformed configuration stops startup.
Unlike Cookbook, which needs one server per member, one endpoint serves
several members, because the token, not the server, selects the member.

**The tools share the web API's code.** The task and list rules (validation,
access checks, locking, repeats, assignees, error messages) moved from the Hono
handlers into `packages/api/src/services/`, which take a database and an
acting user id and return typed results. The web routes are thin adapters with
unchanged responses; the seven MCP tools call the same functions, so they
cannot drift from the web app.

**The caller seam.** `packages/api/src/mcp/caller.ts` is the only code that
turns a request into an acting user (or a 401). The endpoint, the tools and the
services only see that user. Its 401 answers already carry
`WWW-Authenticate: Bearer`, the shape OAuth-capable MCP clients expect. An
OAuth swap through service-auth changes this module only:

- verify the access token (issuer, audience for the Tasks MCP resource,
  expiry) instead of comparing hashes;
- map its subject to a Tasks user through the existing `accounts` link;
- add the protected resource metadata (RFC 9728) and point the 401 challenge
  at it;
- retire `TASKS_MCP_TOKENS` once every client has moved.

service-auth then owns client registration and consent; the tools do not
change.

**The path `/api/mcp`.** Platform Caddy already routes `/api/*` to the API
container, so the endpoint needs no platform-deploy change, no new listener and
no new container, and it stays exactly as private as the rest of Tasks. It is
mounted before the session middleware with its own checks: a foreign `Origin`
answers 403 (browsers and DNS rebinding; MCP clients send none), then the
token, then the method. A session cookie does not authorize it, and a member
token authorizes no other route.

**The household timezone.** The web app takes "today" from the browser. An
agent has no trustworthy clock of its own, and the server's date is UTC, which
is already tomorrow on a Toronto evening. `TASKS_TIMEZONE` (an IANA name,
default `America/Toronto`) decides the household's today: the server
instructions and every tool result state it with the timezone, tools tell
agents to resolve relative dates from it, completing a repeating task schedules
from it, and `overdue` compares with it. An invalid zone stops startup.

## Alternatives considered

- **OAuth through service-auth now.** Rejected for now: it needs client
  registration, consent and token verification in service-auth and a
  protected-resource setup here, for clients that only the household uses.
  The caller seam keeps the swap local.
- **One configured member per server, as in Cookbook.** Rejected: two members
  would need two endpoints and two deployments, while one endpoint with
  per-member tokens needs neither.
- **A separate MCP container or a `/mcp` path.** Rejected: a new container or a
  new Caddy route adds operations and exposure without a need; `/api/mcp`
  reuses the existing route.
- **Session-based or stateful Streamable HTTP.** Rejected: the tools need no
  server push, and stateless requests keep parallel clients independent with
  nothing to expire.
- **The server's UTC date, or a date the agent sends.** Rejected: UTC is the
  wrong day every evening, and an agent's own idea of the date is unreliable.

## Consequences

- Anyone holding a member's token can do everything that member can do in
  Tasks, including permanent deletes. Tokens live in private client
  configuration; revoking one is removing its entry and redeploying.
- Hosted cloud connectors cannot reach the endpoint, which is only on the
  household network; clients must run on a computer that can reach
  `tasks.szarans.ca`.
- A member whose email changes in service-auth needs a new entry.
- The workspace service catalog and architecture documents should list the
  endpoint (a follow-up in the workspace repository).
