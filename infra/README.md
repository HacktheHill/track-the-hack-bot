# Bot deployment guide

This document covers only the infrastructure owned by the Track the Hack bot.
Shared web application, Cloudflare, MySQL, and organization-wide platform
operations belong in the corresponding private operations documentation.

## Production shape

The production bot runs as a single Azure Container App process with:

- an image built from the repository's `Dockerfile` and stored in Azure
  Container Registry;
- internal ingress on port 4000;
- one minimum and one maximum replica, because it maintains a Discord Gateway
  connection and in-memory message batches;
- private connectivity to PostgreSQL and the Track the Hack web application;
- secrets supplied through Container Apps secret bindings or Key Vault
  references; and
- an Azure managed identity when Azure OpenAI extraction is enabled.

The Track the Hack web application calls `POST /verify` over the private
Container Apps network. Both workloads must use the same `INTERNAL_API_SECRET`.
Requests are authenticated with `x-track-the-hack-timestamp` and
`x-track-the-hack-signature`, where the signature is HMAC-SHA256 over
`timestamp.body`.

## Runtime configuration

Use [.env.example](../.env.example) as the configuration inventory. Do not put
production secrets in `.env`, deployment arguments, shell history, or this
repository. Store at least the following as secret values:

- `DISCORD_TOKEN`
- `INTERNAL_API_SECRET`
- `OPENPROJECT_API_KEY`
- `DATABASE_URL`

The other Discord IDs, OpenProject mappings, and feature settings can be normal
Container App environment variables unless organizational policy requires them
to be secrets.

The OpenProject integration is enabled only when all required values accepted by
`src/config.ts` are present. At startup, the bot creates and alters its small
PostgreSQL schema and seeds environment-provided mappings. The database principal
therefore currently requires DDL permissions as well as runtime DML permissions.
If migrations are separated from application startup in the future, update both
the implementation and this guide together.

## Managed identity and Azure OpenAI

Azure OpenAI is optional. When configured, set `AZURE_OPENAI_ENDPOINT` and
`AZURE_OPENAI_DEPLOYMENT`; do not configure an OpenAI API key. The bot uses
`DefaultAzureCredential`, so either a system-assigned or user-assigned Container
App identity can be used. For a user-assigned identity, configure its client ID
as required by the Azure identity environment.

Grant the selected identity the minimum inference role required by the Azure
OpenAI resource, such as **Cognitive Services OpenAI User**. Registry pull and
Key Vault access should likewise be granted only to the identity that needs
them.

Before enabling automatic extraction, evaluate at least 100 representative
conversation windows and record latency, valid-JSON rate, false-task rate,
assignee accuracy, deadline accuracy, token usage, and estimated cost. Keep
`OPENPROJECT_AUTOMATION_MODE=off` during evaluation, then use `shadow` before
`review`. The bot never creates tasks automatically.

## Build and deployment workflow

[container.yml](../.github/workflows/container.yml) validates the application,
runs the tests, and builds the image for pull requests. For non-pull-request
runs, it publishes an immutable image tagged with the Git commit SHA when the
repository variable `AZURE_MIGRATION_ACTIVE` is `true`. Pushes to `main` also
update the `track-the-hack-bot` Container App and verify that an active revision
is healthy.

Configure these as repository or Production-environment settings, according to
the repository's GitHub environment policy:

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret | `AZURE_CLIENT_ID` | Federated deployment identity |
| Secret | `AZURE_TENANT_ID` | Azure tenant |
| Secret | `AZURE_SUBSCRIPTION_ID` | Azure subscription |
| Variable | `AZURE_ACR_LOGIN_SERVER` | Registry login server |
| Variable | `AZURE_RESOURCE_GROUP` | Container App resource group |
| Variable | `AZURE_MIGRATION_ACTIVE` | Enables image publication/deployment |

The federated deployment identity needs permission to push to the registry and
update the bot Container App. The Container App's runtime identity separately
needs `AcrPull` on the registry.

## Health probes

Configure the bot Container App probes against the root-level endpoints:

- `GET /healthz` for liveness; and
- `GET /readyz` for readiness.

Readiness returns 200 only after the Discord client is ready and OpenProject
integration initialization has completed or been intentionally disabled.

## OpenProject service account

[provision-openproject-integration.rb](provision-openproject-integration.rb)
creates or reconciles a least-privilege OpenProject service account, role, and
project memberships. Run it through Rails runner inside the OpenProject
application environment. Set `INTEGRATION_PROJECT_IDS` explicitly rather than
relying on the script's defaults. When `ROTATE_API_TOKEN=true`, its standard
output is the newly generated API token; use a restrictive umask, redirect that
output directly to a mode-600 file, and transfer it to the bot's secret store.
Never print or commit the token.

## Release checks

1. Confirm CI tests and the container build pass for the intended commit.
2. Deploy an immutable commit-SHA image and confirm an active revision is healthy.
3. Check `/healthz`, `/readyz`, and the Discord Gateway connection.
4. Exercise an authenticated Track the Hack-to-bot verification request.
5. If enabled, verify PostgreSQL and OpenProject operations from a permitted
   Organizer channel.
6. If enabled, test Azure OpenAI drafting in an allowlisted non-sensitive channel.
7. Confirm monitoring covers restarts, unhealthy revisions, and zero replicas.
