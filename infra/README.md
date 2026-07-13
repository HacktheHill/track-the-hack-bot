# Azure deployment runbook

This repository does not contain subscription-specific resource IDs, so the
commands below are deliberately parameterized. Authenticate `az`, confirm the
subscription and existing VNet/subnets, then run them from an operator shell.
Do not put database passwords or API keys in command history; use Key Vault or
interactive secret prompts.

The production Container Apps names are exactly:

- `track-the-hack` — web application with internal ACA ingress; public access is through Cloudflare Access
- `track-the-hack-bot` — private bot API and Discord Gateway process

The current deployed environment is `hack-the-hill-ca` in Canada Central. The
web app is available inside the environment at
`track-the-hack.internal.greenstone-ff9cdbe8.canadacentral.azurecontainerapps.io`;
the bot uses the internal hostname
`track-the-hack-bot.internal.greenstone-ff9cdbe8.canadacentral.azurecontainerapps.io`.
The web database is `track-the-hack-mysql-ce` in Canada East (connected through
VNet peering because MySQL provisioning was unavailable in Canada Central), and
the bot database is `track-the-hack-bot-postgres` in Canada Central.

The production Cloudflare Access/tunnel route for `tracker.hackthehill.com`
uses the internal web ACA hostname. The existing tunnel is remotely managed
and runs through the dedicated `track-the-hack-tunnel` Container App. This
keeps Cloudflare Access while preventing clients from bypassing Cloudflare and
removes the VM from the request path.

Do not copy a tunnel token into a repository, deployment argument, or shell
history. Retrieve it from **Cloudflare > Networking > Tunnels > Add a replica**
and enter it directly into Key Vault. A Key Vault-backed Container Apps secret
should expose it to the pinned `cloudflare/cloudflared:2026.7.1` image as
`TUNNEL_TOKEN`; run the container with `tunnel --no-autoupdate run`. The tunnel
app needs no ingress, one minimum replica, and access to the same VNet-integrated
Container Apps environment as `track-the-hack`.

Only after the new connector reports healthy should the maintenance window
begin. Change the route, verify the hostname through Cloudflare Access, then set
the repository variable `AZURE_MIGRATION_ACTIVE=true`. The variable is
intentionally `false` until that controlled cutover; this preserves the VM
deployment as an immediate rollback.

Keep the GitHub repository variable `AZURE_MIGRATION_ACTIVE` set to `false` (or
unset) while preparing the new environment. Set it to `true` only after both
Container Apps pass validation. This disables VM deployment on new pushes and
enables the ACA deployment workflow; the old VM remains available for rollback.

## Required existing values

```bash
az login
az account set --subscription "$SUBSCRIPTION_ID"
az account show

export RG="<resource-group>"
export LOCATION="canadacentral"
export VNET_ID="/subscriptions/.../virtualNetworks/..."
export ACA_SUBNET_ID="/subscriptions/.../subnets/aca"
export DB_SUBNET_ID="/subscriptions/.../subnets/database"
```

The ACA subnet must be delegated to `Microsoft.App/environments`. Database
subnets must be delegated to the appropriate Flexible Server provider and must
have private DNS zones configured. Keep ACA and database subnets separate.

## Shared platform resources

```bash
az provider register --namespace Microsoft.App
az provider register --namespace Microsoft.ContainerRegistry
az provider register --namespace Microsoft.DBforMySQL
az provider register --namespace Microsoft.DBforPostgreSQL
az provider register --namespace Microsoft.KeyVault

az acr create \
  --resource-group "$RG" \
  --name "<globally-unique-acr-name>" \
  --location "$LOCATION" \
  --sku Basic \
  --admin-enabled false

az monitor log-analytics workspace create \
  --resource-group "$RG" \
  --workspace-name "hack-the-hill-logs" \
  --location "$LOCATION"

az containerapp env create \
  --resource-group "$RG" \
  --name "hack-the-hill-ca" \
  --location "$LOCATION" \
  --infrastructure-subnet-resource-id "$ACA_SUBNET_ID" \
  --logs-workspace-id "<workspace-id>" \
  --logs-workspace-key "<workspace-key>"

Create one RBAC-enabled vault and one user-assigned managed identity per
workload. Production currently uses separate bot, web, Prisma Studio, tunnel,
and migration vaults/identities. Grant each identity `Key Vault Secrets User`
only on its own vault; do not grant workload identities access to the legacy
shared vault.

```bash
for workload in bot web prisma tunnel migrate; do
  az identity create --resource-group "$RG" --name "track-the-hack-${workload}"
  az keyvault create \
    --resource-group "$RG" \
    --name "<globally-unique-${workload}-vault-name>" \
    --location "$LOCATION" \
    --enable-rbac-authorization true
done
```

## Managed databases

Create the managed databases first, but do not cut production traffic over to
an empty Track the Hack schema. The VM database contains production user,
hacker, verification, and audit data. Stop the VM web process for the final
dump, import it into managed MySQL, compare exact per-table row counts, and only
then change the Cloudflare origin. The executable
`infra/migrate-track-the-hack-mysql.sh` performs those steps, restarts the old
web process automatically on failure, and intentionally leaves it stopped after
success to prevent split-brain writes. It prompts for the managed MySQL password
without echoing it, or accepts a mode-600 `DESTINATION_PASSWORD_FILE` for an
automated maintenance window. The script downloads Azure MySQL's public DigiCert
root CA only for the run and uses hostname-verified TLS for every destination
connection.

```bash
az mysql flexible-server create \
  --resource-group "$RG" \
  --name "track-the-hack-mysql-ce" \
  --location "canadaeast" \
  --version 8.0.21 \
  --sku-name Standard_B1ms \
  --storage-size 32 \
  --vnet "<database-vnet-in-canadaeast>" \
  --subnet "<mysql-subnet-in-canadaeast>" \
  --private-dns-zone "<mysql-private-dns-zone-id>"

az postgres flexible-server create \
  --resource-group "$RG" \
  --name "track-the-hack-bot-postgres" \
  --location "$LOCATION" \
  --version 16 \
  --sku-name Standard_B1ms \
  --storage-size 32 \
  --vnet "$VNET_ID" \
  --subnet "$DB_SUBNET_ID" \
  --private-dns-zone "<postgres-private-dns-zone-id>"
```

Use separate MySQL and PostgreSQL subnets if the selected Azure region/provider
requires separate delegation. Confirm the current CLI syntax with `az ... -h`
after authentication before provisioning.

Use distinct MySQL principals:

- `track_the_hack_app`: runtime DML only; no DDL or grant permissions;
- `track_the_hack_migrator`: schema migration permissions on the application
  database only, stored only in the migration vault;
- `track_the_hack_prisma`: read-only (`SELECT`) for Prisma Studio.

`infra/provision-mysql-users.mjs` creates and verifies these grants over
hostname-verified TLS. The runtime container must never receive the migrator or
administrator URL. Rotate the server administrator password after provisioning
and migration, then securely remove temporary credential files.

## Container Apps

Build and publish the bot image using `.github/workflows/container.yml`. Build
the Track the Hack application from its own repository into a separate image.

```bash
az containerapp create \
  --resource-group "$RG" \
  --name "track-the-hack" \
  --environment "hack-the-hill-ca" \
  --image "<acr>.azurecr.io/track-the-hack:<git-sha>" \
  --registry-server "<acr>.azurecr.io" \
  --registry-identity system \
  --system-assigned \
  --ingress internal \
  --target-port 3000 \
  --min-replicas 1 \
  --max-replicas 2

az containerapp create \
  --resource-group "$RG" \
  --name "track-the-hack-bot" \
  --environment "hack-the-hill-ca" \
  --image "<acr>.azurecr.io/track-the-hack-bot:<git-sha>" \
  --registry-server "<acr>.azurecr.io" \
  --registry-identity system \
  --system-assigned \
  --ingress internal \
  --target-port 4000 \
  --min-replicas 1 \
  --max-replicas 1
```

Configure secrets through Key Vault references or Container Apps secret
bindings. Set `DISCORD_BOT_URL` in the web app to the bot's internal HTTPS
address and set `INTERNAL_API_SECRET` in both apps. Legacy body-secret
authentication is disabled by default; enable `ALLOW_LEGACY_API_SECRET=true`
only for a bounded migration window, then explicitly remove it or set it to
`false` after signed requests are verified.

The bot requires its dedicated user-assigned managed identity with:

- AcrPull on the registry;
- inference permission on the Azure OpenAI resource;
- read access to its Key Vault secrets;
- PostgreSQL connection access as configured by the database authentication mode.

Production alerting uses the `TrackTheHack-Alerts` action group
(`development@ctn-rtc.org`) and currently includes restart and zero-replica
metric alerts for both `track-the-hack` and `track-the-hack-bot`. Keep these
alerts enabled when changing revision scaling or names.

The web image has separate `runtime` and `migration` targets. Runtime startup
must not run Prisma migrations. Before updating the web revision, configure and
run the dedicated Container Apps migration job with
`track-the-hack/infra/configure-migration-job.sh`; the job alone receives the
migrator identity and URL. Only deploy the runtime revision after the job exits
successfully. Configure `/api/healthz` as liveness and `/api/readyz` as readiness
with `track-the-hack/infra/configure-health-probes.sh`.

## Azure task extraction

The bot uses the `track-the-hack-ai` Azure OpenAI resource through its Container
App managed identity. Configure `AZURE_OPENAI_ENDPOINT` and one deployment name,
`AZURE_OPENAI_DEPLOYMENT`. Do not configure an API key. The
identity needs only the Cognitive Services OpenAI User role on that resource.

The bot bounds and pseudonymizes context before inference. It removes common
credentials and contact details, omits attachment contents, and rejects the
entire extraction before requesting Azure when its deterministic sensitive-data
filter matches. This is risk reduction rather than a guarantee; use manual task
creation for sensitive discussions.

Before enabling this in production, benchmark at least 100 representative
conversation windows and record inference latency, valid JSON rate, false-task
rate, assignee accuracy, deadline accuracy, token use, and estimated cost. Keep
`OPENPROJECT_AUTOMATION_MODE=off` until that evaluation is complete, then use
`shadow` before `review`. Automatic creation is not enabled.

## Cutover and rollback

1. Deploy both apps with temporary validation URLs.
2. Initialize fresh MySQL and PostgreSQL schemas.
3. Test private app-to-bot HTTPS, Discord Gateway, OpenProject, health, and
   readiness endpoints. Test Azure OpenAI if automation has been enabled.
4. Start the dedicated ACA `cloudflared` replica with the existing remotely
   managed tunnel token and confirm that the tunnel remains healthy.
5. Stop the VM web process and run
   `infra/migrate-track-the-hack-mysql.sh` on the VM. It takes a consistent
   dump, recreates the managed schema, imports it, and compares every table.
6. Change the Cloudflare published application's service URL to
   `track-the-hack`, validate login and critical flows through Cloudflare
   Access, then set `AZURE_MIGRATION_ACTIVE=true` in both repositories.
7. Change web ingress to internal, update the tunnel service URL to the new
   internal ACA hostname, and validate again.
8. Keep the old VM deployment and database frozen for the agreed rollback window.
9. Roll back Cloudflare routing if application or bot validation fails.
10. After the window, remove the old PM2 processes, self-hosted runner, VM
   database, and VM only after backups and logs are verified.
