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

Create one RBAC-enabled vault and managed identity only where a workload needs
one. Production uses dedicated secrets for the bot, web application, Prisma
Studio, and tunnel. Grant each identity `Key Vault Secrets User` only on its
own vault.

```bash
for workload in bot web prisma tunnel; do
  az identity create --resource-group "$RG" --name "track-the-hack-${workload}"
  az keyvault create \
    --resource-group "$RG" \
    --name "<globally-unique-${workload}-vault-name>" \
    --location "$LOCATION" \
    --enable-rbac-authorization true
done
```

## Managed databases

Production data is in managed MySQL and PostgreSQL Flexible Server instances.
Their public network access is disabled; retain the VNet peerings and private
DNS zones that resolve their current private hostnames.

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
- `track_the_hack_prisma`: read-only (`SELECT`) for Prisma Studio.

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
address and set `INTERNAL_API_SECRET` in both apps. The bot accepts only a
timestamped HMAC request (`x-track-the-hack-timestamp` and
`x-track-the-hack-signature`) from the web app.

The bot requires its dedicated user-assigned managed identity with:

- AcrPull on the registry;
- inference permission on the Azure OpenAI resource;
- read access to its Key Vault secrets;
- PostgreSQL connection access as configured by the database authentication mode.

Production alerting uses the `TrackTheHack-Alerts` action group
(`development@ctn-rtc.org`) and currently includes restart and zero-replica
metric alerts for both `track-the-hack` and `track-the-hack-bot`. Keep these
alerts enabled when changing revision scaling or names.

Runtime startup must not make schema changes. Plan and review any future
database migration as a separate, temporary privileged operation rather than
keeping a permanent migration workload or credential in production. Configure
`/api/healthz` as liveness and `/api/readyz` as readiness.

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

## Release checks

1. Build a versioned image in `trackthehackacr` and deploy the corresponding
   internal Container App revision.
2. Verify the web app, bot `/healthz` and `/readyz`, Discord Gateway,
   OpenProject, and the private web-to-bot HMAC call.
3. Verify `tracker.hackthehill.com` and `prisma.hackthehill.com` through
   Cloudflare Access. The remote tunnel ingress rules must set
   `originRequest.httpHostHeader` to the relevant internal ACA FQDN.
4. Keep the four Container Apps, managed databases, ACR, private DNS/VNet
   dependencies, dedicated Key Vaults, and production alerts under monitoring.
