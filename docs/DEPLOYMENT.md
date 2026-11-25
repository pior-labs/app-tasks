# Deployment operations

This repository owns its release images and database migrations. Shared ingress,
networks and database provisioning remain in `platform-deploy`. The workflow is
manual by choice. These procedures apply after this revision is merged; source
configuration alone does not provision a runner or establish a live deployment.

## Configure before first deployment

- Register the dedicated repository runner with the labels in `deploy.yml`.
  Runner provisioning remains a separate host operation.
- Keep `DEPLOY_DIR` a dedicated absolute application directory with write access
  for that runner. Python 3, curl with `--retry-all-errors`, Docker Compose with
  `up --wait`, and GHCR access are required. Registry credentials use the
  workflow's temporary `GITHUB_TOKEN`; production installs no Node dependencies.
- Set the `PRODUCTION` environment secret `COMPOSE_PROJECT_NAME` to the **existing**
  production Compose project identity. Inspect an existing container's
  `com.docker.compose.project` label before migrating; a different name can
  create a second project or collide with named containers. For a new app,
  choose its unique project name before initial deployment.
- Configure the individual settings below. `APP_ENV` is no longer read.
- Confirm this repository can create/read its GHCR packages. Existing packages
  need Actions access for this repository. Keep visibility private unless a
  public release is deliberately agreed.
- Provision shared database credentials, networks, OAuth client and Caddy routes
  before deployment. The application cannot establish those dependencies itself.

## Individual production settings

All production settings live in the `PRODUCTION` environment, which only the
`main` branch should be allowed to deploy from. Do not duplicate them at
repository scope: an environment value silently overrides a repository value
with the same name, so duplicates hide mistakes.

Set these `PRODUCTION` environment secrets:

| Secret | Value |
| --- | --- |
| `COMPOSE_PROJECT_NAME` | `tasks` for the first deployment; preserve the existing identity afterward |
| `CENTRAL_AUTH_CLIENT_SECRET` | The same private value registered as Auth's `TASKS_CLIENT_SECRET` |
| `BETTER_AUTH_SECRET` | A separate, stable application session secret, at least 32 characters |
| `TASKS_MCP_TOKENS` | Optional. MCP member token hashes, see [MCP member tokens](#mcp-member-tokens). Unset: the MCP endpoint answers 401 |

Set the `PRODUCTION` environment variable `DEPLOY_DIR` to `/opt/docker/app-tasks`.
It is required. The following `PRODUCTION` environment variables are optional
overrides of the versioned defaults in `scripts/deploy.py`. Leave them unset;
change the default in a reviewed PR instead, and use a variable only for a
deliberate temporary override:

| Variable | Default |
| --- | --- |
| `APP_SLUG` | `tasks` |
| `PUBLIC_BASE_URL` | `https://tasks.szarans.ca` |
| `BETTER_AUTH_URL` | `https://tasks.szarans.ca` |
| `BETTER_AUTH_TRUSTED_ORIGINS` | `https://tasks.szarans.ca` |
| `CENTRAL_AUTH_ISSUER` | `https://auth.szarans.ca/api/auth` |
| `CENTRAL_AUTH_CLIENT_ID` | `tasks` |
| `PLATFORM_DATABASE_URL_FILE` | `/opt/docker/pior-labs/secrets/app-tasks/database-url` |
| `TASKS_TIMEZONE` | `America/Toronto` (the household's IANA timezone, which decides "today" for MCP tools) |

Only this explicit allowlist is written to the private runtime `.env`. Missing,
placeholder or short session secrets fail before staging or Docker operations.
Values must be single-line; quotes, backslashes and dollar signs are encoded
for Compose rather than pasted as dotenv syntax. Local `.env` and
`.env.local` development configuration still follow `.env.example`.

The database connection stays in the platform-managed file on the host, mounted
read-only into the API. Do not add `DATABASE_URL` or a database password to
Actions. Changing an origin, issuer, client ID, slug or database-file path also
requires the corresponding Auth/platform configuration; the workflow does not
provision those dependencies. Ingress health probes remain tied to the canonical
Tasks hostname in `scripts/deployment.json`.

## Changing or rotating one setting

Each setting is independent, so a change touches only that one value:

1. Update the value under Settings, Environments, `PRODUCTION` (or
   `gh secret set <NAME> --env PRODUCTION`, which prompts for the value; do not
   pass secrets with `--body`, which leaves them in shell history and process
   listings).
2. Dispatch Deploy with the CI run ID of the release that is already live
   (`run_id` in `$DEPLOY_DIR/.deployments/current.json`). Settings apply only on
   the next deployment; redeploying the live release changes nothing else.
3. Verify sign-in at `https://tasks.szarans.ca`.

Value-specific notes:

- `CENTRAL_AUTH_CLIENT_SECRET` must equal Auth's `TASKS_CLIENT_SECRET`. Rotate
  it in Auth first, deploy Auth, then update and deploy Tasks; sign-in fails
  between the two deployments.
- A new `BETTER_AUTH_SECRET` signs everyone out. Keep the value stable unless
  rotation is intended.
- `COMPOSE_PROJECT_NAME` is an identity, not a credential. Changing it creates a
  second Compose project instead of updating the existing one.
- To copy a current value from the host, use the newest
  `$DEPLOY_DIR/releases/*/.env`: strip the surrounding double quotes, turn `$$`
  back into `$` and JSON escapes such as `\\` back into their characters.

## MCP member tokens

The MCP endpoint `https://tasks.szarans.ca/api/mcp` (README, "MCP") accepts
member bearer tokens. `TASKS_MCP_TOKENS` holds only their SHA-256 hashes, as
comma-separated `<member email>:<sha256 hex>` entries, for example
`one@example.com:<64 hex>,two@example.com:<64 hex>`. The rationale is in
[decision 0001](decisions/0001-mcp-member-tokens.md).

1. On a trusted computer with this repository, run
   `pnpm --filter @tasks/api mcp:token <member email>`. It prints the token
   once and the entry. Give the token to the member's MCP client; it cannot be
   shown again.
2. Set the whole list as the secret: `gh secret set TASKS_MCP_TOKENS --env PRODUCTION`
   (it prompts; paste every entry, comma-separated). The value replaces the
   previous one, so include the entries that should keep working.
3. Redeploy the live release (see "Changing or rotating one setting" above).
   The member must have signed in to Tasks once; until then their token
   answers 401.

To rotate, add the new entry beside the old one (an email may have several),
redeploy, switch the client, then remove the old entry and redeploy. To revoke,
remove the entry and redeploy; with the secret unset or empty, every MCP request
answers 401. Deploy rejects a malformed value before staging, naming only the
setting; the API also refuses to start with one, and with an unknown
`TASKS_TIMEZONE`. The hashes are not credentials, but keep the secret private
anyway: it names the members' emails.

`TASKS_TIMEZONE` changes what "today" and "tomorrow" mean for agents. Leave the
default unless the household moves; it has no effect on the web app, which
uses the browser's date.

No platform-deploy change is needed: platform Caddy already routes `/api/*` to
the API container, and the endpoint stays as private as the rest of Tasks.

## Release and deployment

PR CI performs the repository's application checks, release-tool tests and Docker
builds without publishing. Successful pushes to main publish all configured
service images to `ghcr.io/pior-labs/app-tasks-<service>` and save a
`release-<attempt>` manifest containing their digests and source commit.

1. Merge the reviewed application change and wait for the **whole CI run on main**
   to succeed, including Build release images.
2. Open Deploy and select branch `main`. Supply the full numeric CI run ID from
   `/actions/runs/<ID>` in the successful run's URL, **not** its displayed #number.
3. Leave `ci_run_attempt` blank for the latest successful attempt, or supply the
   exact recorded attempt when redeploying an older release.
4. The hosted resolve job verifies run/workflow identity, main ancestry, successful
   conclusion and artifact contents before the production runner is used.
5. Production pulls verified images, runs migrations, waits for container health,
   and probes `https://tasks.szarans.ca` through platform ingress. It neither rebuilds images nor
   fetches a moving production branch.

All workflow-managed production operations share this repository's production
concurrency group and do not cancel a running deployment. GitHub may replace a
pending request; this is not a FIFO queue. New maintenance workflows must use the
same group. Do not run manual host maintenance concurrently with deployment.

## Records and recovery

Runtime configuration is private beneath `$DEPLOY_DIR/releases/`. The successful
runtime is linked as `$DEPLOY_DIR/current`. For host diagnostics:

```sh
cd "$DEPLOY_DIR/current"
export COMPOSE_FILE="$PWD/compose.json"
docker compose ps
```

The resolved Compose file contains secrets, has no build definitions and pins
images by digest. Do not commit or upload it. The legacy root checkout is no
longer the active runtime configuration. Keep persistent application data outside
release directories.

`$DEPLOY_DIR/.deployments/current.json` records the last healthy release;
`previous.json` preserves the preceding healthy release; `attempt.json` records
the latest operation, including failure. Failed attempts preserve successful
records but may have changed the database or running containers. Inspect the
attempt's `runtime_dir` for diagnosis. Compose configuration failures save
`compose-config.stderr` there with private permissions; inspect it on the host
and do not paste its contents publicly because parser errors can contain secrets. There is no recorded predecessor for the
first deployment migrated from source builds.

To roll application images back, dispatch Deploy with the previous record's
`run_id` **and** `run_attempt`. The current secrets are used. Migrations are
forward-only; an older application must remain compatible with the current
schema. Use additive schema changes across rollout/rollback windows. Database
restoration requires a separate application-owned recovery procedure, never an
automatic downgrade after an unhealthy deployment.

Manifests are retained for 90 days. Keep their GHCR images for at least that long,
and never remove images used by the current or previous deployment. Expired
manifests cannot be selected. Private host runtime directories retain historical
secrets; clean them deliberately while preserving current/previous/attempted
runtimes and all persistent data.
