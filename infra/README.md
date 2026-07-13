# Azure deployment runbook

This repository does not contain subscription-specific resource IDs, so the
commands below are deliberately parameterized. Authenticate `az`, confirm the
subscription and existing VNet/subnets, then run them from an operator shell.
Do not put database passwords or API keys in command history; use Key Vault or
interactive secret prompts.

The production Container Apps names are exactly:

- `track-the-hack` — public web application
- `track-the-hack-bot` — private bot API and Discord Gateway process

The current deployed environment is `hack-the-hill-ca` in Canada Central. The
web app is available at its temporary ACA hostname
`track-the-hack.greenstone-ff9cdbe8.canadacentral.azurecontainerapps.io`; the
bot uses the internal hostname
`track-the-hack-bot.internal.greenstone-ff9cdbe8.canadacentral.azurecontainerapps.io`.
The web database is `track-the-hack-mysql-ce` in Canada East (connected through
VNet peering because MySQL provisioning was unavailable in Canada Central), and
the bot database is `track-the-hack-bot-postgres` in Canada Central.

The ACA endpoints are validated, but the production Cloudflare Access/tunnel
route for `tracker.hackthehill.com` still points at the VM. Change that route to
the web ACA hostname, verify the hostname, then set the repository variable
`AZURE_MIGRATION_ACTIVE=true`. The variable is intentionally `false` until that
controlled cutover; this preserves the VM deployment as an immediate rollback.

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

az keyvault create \
  --resource-group "$RG" \
  --name "<globally-unique-key-vault-name>" \
  --location "$LOCATION" \
  --enable-rbac-authorization true
```

## Managed databases

Create new empty databases. Existing VM data is intentionally not migrated.
Choose administrator credentials interactively and store application secrets in
Key Vault.

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
  --ingress external \
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
address and set `INTERNAL_API_SECRET` in both apps. During cutover, keep
`ALLOW_LEGACY_API_SECRET=true`; set it to `false` after the web app sends signed
requests successfully.

The bot requires a system/user-assigned managed identity with:

- AcrPull on the registry;
- inference permission on the Azure OpenAI resource;
- read access to its Key Vault secrets;
- PostgreSQL connection access as configured by the database authentication mode.

## Cutover and rollback

1. Deploy both apps with temporary validation URLs.
2. Initialize fresh MySQL and PostgreSQL schemas.
3. Test private app-to-bot HTTPS, Discord Gateway, OpenProject, Azure OpenAI,
   health, and readiness endpoints.
4. Point the existing Cloudflare hostname at `track-the-hack`.
5. Keep the old VM deployment frozen for the agreed rollback window.
6. Roll back Cloudflare routing if application or bot validation fails.
7. After the window, remove the old PM2 processes, self-hosted runner, VM
   database, and VM only after backups and logs are verified.
