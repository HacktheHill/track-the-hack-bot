import { Client, GatewayIntentBits } from "discord.js";
import { config } from "dotenv";
import registerHelpCommand from "./help.js";
import registerSyncCommand from "./sync.js";
import registerVerificationCommand from "./verification.js";

config();

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
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

client.once("ready", () => {
	console.log(`Logged in as ${client.user?.tag ?? "Unknown"}`);

	registerHelpCommand(client);
	registerSyncCommand(client);
	registerVerificationCommand(client);
});

client.login(DISCORD_TOKEN);

export function getClient() {
	return client;
}
