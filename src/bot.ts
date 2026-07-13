import { Client, GatewayIntentBits } from "discord.js";
import { config } from "dotenv";
import registerHelpCommand from "./help.js";
import registerSyncCommand, { registerGuildMemberAddHandler } from "./sync.js";
import registerVerificationCommand from "./verification.js";
import { loadIntegrationConfig } from "./config.js";
import { Database } from "./database.js";
import { OpenProjectClient } from "./openproject.js";
import { registerTaskInteractions } from "./tasks.js";
import { HybridTaskExtractor } from "./azure-openai.js";
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

client.once("ready", async () => {
	console.log(`Logged in as ${client.user?.tag ?? "Unknown"}`);

	registerHelpCommand(client);
	registerSyncCommand(client);
	registerVerificationCommand(client);

	registerGuildMemberAddHandler(client);

	const integrationConfig = loadIntegrationConfig();
	if (integrationConfig) {
		const db = new Database(integrationConfig.DATABASE_URL);
		await db.migrate(integrationConfig);
		const services = {
			config: integrationConfig,
			db,
			openProject: new OpenProjectClient(integrationConfig),
			extractor: new HybridTaskExtractor(integrationConfig),
		};
		registerTaskInteractions(client, services);
		registerAutomaticTaskDetection(client, services);
		console.log("OpenProject task integration enabled");
	} else {
		console.warn("OpenProject task integration disabled: required configuration is missing");
	}
});

client.login(DISCORD_TOKEN);

export function getClient() {
	return client;
}
