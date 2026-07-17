# Bot deployment guide

This document covers only the infrastructure owned by the Track the Hack bot.
Shared web application, Cloudflare, MySQL, and organization-wide platform
operations belong in the corresponding private operations documentation.

The cross-workload Azure backup implementation and restore runbook are owned by
the private [`infrastructure`](https://github.com/HacktheHill/infrastructure)
repository. That runbook covers Track the Hack, this bot, and OpenProject;
Cloudflare R2 remains explicitly out of scope.

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
- `OUTREACH_DISCORD_SIGNING_SECRET`
- `OPENPROJECT_API_KEY`
- `DATABASE_URL`

The other Discord IDs, OpenProject mappings, and feature settings can be normal
Container App environment variables unless organizational policy requires them
to be secrets.

The optional outreach integration registers an organizer-guild message context
command that sends only the selected message to the outreach service. Configure
`OUTREACH_SERVICE_URL`, `OUTREACH_DISCORD_KEY_ID`,
`OUTREACH_DISCORD_SIGNING_SECRET`, and the JSON
`OUTREACH_DISCORD_ALLOWED_CHANNEL_IDS` together. The signing secret must be a
dedicated secret value and must match an active key ID in the outreach service.
Requests use the private service route and bind the method, path, timestamp,
nonce, and exact body digest with HMAC-SHA256. Rotate keys with an overlap period
before removing the old key. The bot sends no surrounding messages,
attachments, reactions, or member lists, and the outreach service independently
enforces the same guild and channel allowlists.

The OpenProject integration is enabled only when all required values accepted by
`src/config.ts` are present. For production, run `npm run migrate:db` as a
reviewed one-off Container Apps Job, then set `OPENPROJECT_RUN_MIGRATIONS=false`
on the bot. Local development may keep the default `true` value. After the
migration job completes, the bot runtime principal needs only runtime DML
permissions.

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

Evaluate at least 100 representative pseudonymized conversation windows and
record latency, valid-output rate, false-task rate, assignee accuracy, deadline
accuracy, source-ID accuracy, and token usage. Production may remain in
`OPENPROJECT_AUTOMATION_MODE=review` while this evaluation improves; every
proposal still requires a permitted human reviewer and the bot never creates
tasks automatically. `off` remains the emergency kill switch.

RAG requires separate Azure OpenAI embedding configuration and the PostgreSQL
`vector` extension. Set `OPENPROJECT_RAG_MODE=shadow` to synchronize vectors
without changing proposal behavior, then use `review` only after validating
similarity thresholds. Run `npm run sync:embeddings` from a private scheduled
Container Apps Job with the same managed identity, PostgreSQL network path,
Key Vault bindings, and Azure OpenAI access as the bot.

Required settings are `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`,
`AZURE_OPENAI_EMBEDDING_DIMENSIONS`, `OPENPROJECT_RAG_MODE`, and
`OPENPROJECT_EXCLUDED_CHANNEL_IDS`. The embedding deployment must be separate
from the chat extraction deployment. RAG proposals use PostgreSQL similarity
search filtered by OpenProject project and are applied only after a reviewer
confirms the update; the current `lockVersion` is checked immediately before
the PATCH.

## Build and deployment workflow

[container.yml](../.github/workflows/container.yml) validates the application,
runs the tests, and builds the image for pull requests. For non-pull-request
runs on `main`, it publishes an immutable image tagged with the Git commit SHA,
updates the `track-the-hack-bot` Container App, and verifies that an active
revision is healthy. The `Production` environment must require a reviewer and
must be restricted to `main`.

Configure these as repository or Production-environment settings, according to
the repository's GitHub environment policy:

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret | `AZURE_CLIENT_ID` | Federated deployment identity |
| Secret | `AZURE_TENANT_ID` | Azure tenant |
| Secret | `AZURE_SUBSCRIPTION_ID` | Azure subscription |
| Variable | `AZURE_ACR_LOGIN_SERVER` | Registry login server |
| Variable | `AZURE_RESOURCE_GROUP` | Container App resource group |

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

[provision-integration.rb](../scripts/openproject/provision-integration.rb)
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
7. Confirm the bot has **Manage Webhooks** in channels where organizers schedule messages, then test scheduling and cancellation.
8. Confirm monitoring covers restarts, unhealthy revisions, and zero replicas.
