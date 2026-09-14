import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v9";
import { SlashCommandBuilder } from "@discordjs/builders";
import { config } from "dotenv";
import { aiTaskMessageCommand, taskCommand, taskMessageCommand } from "./tasks.js";
import { scheduleCommand } from "./scheduler.js";
import { loadTeamFinderConfig } from "./config.js";
import { teamFinderRegistration } from "./team-finder-command.js";

config();

const { CLIENT_ID, COMMUNITY_GUILD_ID, ORGANIZER_GUILD_ID, DISCORD_TOKEN } =
	process.env;

if (
	!CLIENT_ID ||
	!COMMUNITY_GUILD_ID ||
	!ORGANIZER_GUILD_ID ||
	!DISCORD_TOKEN
) {
	console.error("Missing environment variables");
	process.exit(1);
}

const teamFinderCommands = teamFinderRegistration(loadTeamFinderConfig());

const communityCommands = [
	new SlashCommandBuilder()
		.setName("verify")
		.setDescription(
			"Get a verification link | Obtenir un lien de vérification",
		)
		.toJSON(),
	...teamFinderCommands.community,
];

const organizerCommands = [
	new SlashCommandBuilder()
		.setName("sync")
		.setDescription(
			"Synchronize roles and nicknames | Synchroniser les rôles et les surnoms",
		)
		.toJSON(),
	taskCommand.toJSON(),
	scheduleCommand.toJSON(),
	taskMessageCommand.toJSON(),
	aiTaskMessageCommand.toJSON(),
	...teamFinderCommands.organizer,
];

const sharedCommands = [
	new SlashCommandBuilder()
		.setName("help")
		.setDescription("Get help | Obtenir de l'aide")
		.toJSON(),
	...teamFinderCommands.shared,
];

const rest = new REST().setToken(DISCORD_TOKEN);

try {
	console.log("Started refreshing application (/) commands.");

	await rest.put(
		Routes.applicationGuildCommands(CLIENT_ID, COMMUNITY_GUILD_ID),
		{
			body: communityCommands,
		},
	);

	await rest.put(
		Routes.applicationGuildCommands(CLIENT_ID, ORGANIZER_GUILD_ID),
		{
			body: organizerCommands,
		},
	);

	await rest.put(Routes.applicationCommands(CLIENT_ID), {
		body: sharedCommands,
	});

	console.log("Successfully reloaded application (/) commands.");
} catch (error) {
	console.error(error);
}
