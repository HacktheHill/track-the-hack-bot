import { Client, GatewayIntentBits } from "discord.js";
import { config } from "dotenv";
import registerHelpCommand from "./help.js";
import registerSyncCommand, { registerGuildMemberAddHandler } from "./sync.js";
import registerVerificationCommand from "./verification.js";
import { loadIntegrationConfig, loadOutreachConfig } from "./config.js";
import { Database } from "./database.js";
import { OpenProjectClient } from "./openproject.js";
import { registerTaskInteractions } from "./tasks.js";
import { AzureTaskExtractor } from "./azure-openai.js";
import { registerAutomaticTaskDetection } from "./automatic-tasks.js";
import { reconcileOpenProjectUsers } from "./identity.js";
import { AzureEmbeddingClient } from "./embeddings.js";
import { OpenProjectRag } from "./rag.js";
import { registerMessageScheduler } from "./scheduler.js";
import { registerOutreachInteractions } from "./outreach.js";

config();

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

const {
	PORT = 4000,
	COMMUNITY_GUILD_ID,
	ORGANIZER_GUILD_ID,
	COMMUNITY_GUILD_HACKER_ROLE_ID,
	LOG_CHANNEL_ID,
	INTERNAL_API_SECRET,
	TRACK_THE_HACK_URL,
	DISCORD_TOKEN,
} = process.env;

if (
	!PORT ||
	!COMMUNITY_GUILD_ID ||
	!ORGANIZER_GUILD_ID ||
	!COMMUNITY_GUILD_HACKER_ROLE_ID ||
	!LOG_CHANNEL_ID ||
	!INTERNAL_API_SECRET ||
	!TRACK_THE_HACK_URL ||
	!DISCORD_TOKEN
) {
	console.error("Missing environment variables");
	process.exit(1);
}

let integrationDb: Database | undefined;
let integrationReady = false;

client.once("clientReady", async () => {
	console.log(`Logged in as ${client.user?.tag ?? "Unknown"}`);

	registerHelpCommand(client);
	registerSyncCommand(client);
	registerVerificationCommand(client);

	registerGuildMemberAddHandler(client);
	const outreachConfig = loadOutreachConfig();
	registerOutreachInteractions(client, outreachConfig);
	if (outreachConfig) {
		console.log("Outreach evidence integration enabled");
	} else {
		console.warn("Outreach evidence integration disabled: configuration is missing");
	}

	const integrationConfig = loadIntegrationConfig();
	if (integrationConfig) {
		const db = new Database(integrationConfig.DATABASE_URL);
		integrationDb = db;
		if (integrationConfig.OPENPROJECT_RUN_MIGRATIONS) await db.migrate(integrationConfig);
		await db.cleanup(integrationConfig);
		const openProject = new OpenProjectClient(integrationConfig);
		const rag = integrationConfig.OPENPROJECT_RAG_MODE !== "off" && integrationConfig.AZURE_OPENAI_EMBEDDING_DEPLOYMENT
			? new OpenProjectRag(integrationConfig, db, openProject, new AzureEmbeddingClient(integrationConfig))
			: undefined;
		const services = {
			config: integrationConfig,
			db,
			openProject,
			extractor: new AzureTaskExtractor(integrationConfig),
			rag,
		};
		registerTaskInteractions(client, services);
		registerAutomaticTaskDetection(client, services);
		const organizerGuild = await client.guilds.fetch(integrationConfig.ORGANIZER_GUILD_ID);
		const reconcileIdentities = () => void reconcileOpenProjectUsers(organizerGuild, integrationConfig, db, services.openProject)
			.then(result => console.log("OpenProject identity reconciliation complete", result))
			.catch(error => console.error("OpenProject identity reconciliation failed", { error: (error as Error).message }));
		reconcileIdentities();
		setInterval(reconcileIdentities, 24 * 60 * 60 * 1000).unref();
		if (rag?.enabled) {
			void rag.sync().catch(error => console.error("Initial OpenProject embedding sync failed", { error: (error as Error).message }));
			setInterval(() => void rag.sync().catch(error => console.error("OpenProject embedding sync failed", { error: (error as Error).message })), integrationConfig.OPENPROJECT_RAG_SYNC_INTERVAL_SECONDS * 1000).unref();
		}
		integrationReady = true;
		setInterval(() => void db.cleanup(integrationConfig).catch(error => console.error("Proposal cleanup failed", error)), 24 * 60 * 60 * 1000).unref();
		console.log("OpenProject task integration enabled");
	} else {
		console.warn("OpenProject task integration disabled: required configuration is missing");
		integrationReady = true;
	}
	registerMessageScheduler(client, integrationDb, ORGANIZER_GUILD_ID, integrationConfig?.BOT_TIME_ZONE);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		void (async () => {
			integrationReady = false;
			client.destroy();
			await integrationDb?.close();
			process.exit(0);
		})();
	});
}

client.login(DISCORD_TOKEN);

export function getClient() {
	return client;
}

export function isIntegrationReady() {
	return integrationReady;
}
