import { Client, GatewayIntentBits } from "discord.js";
import { config } from "dotenv";
import registerHelpCommand from "./help.js";
import registerSyncCommand, { registerGuildMemberAddHandler } from "./sync.js";
import registerVerificationCommand from "./verification.js";
import { loadIntegrationConfig } from "./config.js";
import { Database } from "./database.js";
import { OpenProjectClient } from "./openproject.js";
import { registerTaskInteractions } from "./tasks.js";
import { AzureTaskExtractor } from "./azure-openai.js";
import { registerAutomaticTaskDetection } from "./automatic-tasks.js";

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
	SECRET_KEY,
	TRACK_THE_HACK_URL,
	DISCORD_TOKEN,
} = process.env;

if (
	!PORT ||
	!COMMUNITY_GUILD_ID ||
	!ORGANIZER_GUILD_ID ||
	!COMMUNITY_GUILD_HACKER_ROLE_ID ||
	!LOG_CHANNEL_ID ||
	!SECRET_KEY ||
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

	const integrationConfig = loadIntegrationConfig();
	if (integrationConfig) {
		const db = new Database(integrationConfig.DATABASE_URL);
		integrationDb = db;
		await db.migrate(integrationConfig);
		await db.cleanup(integrationConfig);
		const services = {
			config: integrationConfig,
			db,
			openProject: new OpenProjectClient(integrationConfig),
			extractor: new AzureTaskExtractor(integrationConfig),
		};
		registerTaskInteractions(client, services);
		registerAutomaticTaskDetection(client, services);
		integrationReady = true;
		setInterval(() => void db.cleanup(integrationConfig).catch(error => console.error("Proposal cleanup failed", error)), 24 * 60 * 60 * 1000).unref();
		console.log("OpenProject task integration enabled");
	} else {
		console.warn("OpenProject task integration disabled: required configuration is missing");
		integrationReady = true;
	}
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
