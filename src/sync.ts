import { Client } from "discord.js";
import { config } from "dotenv";

config();

const { ORGANIZER_GUILD_ID, COMMUNITY_GUILD_ID } = process.env;

if (!ORGANIZER_GUILD_ID || !COMMUNITY_GUILD_ID) {
	console.error("Missing environment variables for sync");
	process.exit(1);
}

const registerSyncCommand = async (client: Client) => {
	client.on("interactionCreate", async interaction => {
		if (!interaction.isCommand()) return;

		const { commandName } = interaction;

		if (commandName === "sync") {
			try {
				await interaction.reply({
					content:
						"Syncing roles and nicknames | Synchronisation des rôles et des surnoms",
					ephemeral: true,
				});

				const organizerGuild = await client.guilds.fetch(
					ORGANIZER_GUILD_ID,
				);
				const communityGuild = await client.guilds.fetch(
					COMMUNITY_GUILD_ID,
				);
				const organizerMembers = await organizerGuild.members.fetch();
				const communityMembers = await communityGuild.members.fetch();

				for (const [_, organizerMember] of organizerMembers) {
					const communityMember = communityMembers.get(
						organizerMember.id,
					);
					if (communityMember) {
						await communityMember.roles.set(
							organizerMember.roles.cache,
						);
						await communityMember.setNickname(
							organizerMember.nickname,
						);
					}
				}

				await interaction.editReply({
					content:
						"Roles and nicknames synced | Rôles et surnoms synchronisés",
				});
			} catch (error) {
				console.error("Error during sync:", error);
				try {
					const errorMessage =
						"An error occurred during sync. Please try again later. | Une erreur s'est produite lors de la synchronisation. Veuillez réessayer plus tard.";
					if (interaction.replied || interaction.deferred) {
						await interaction.editReply({
							content: errorMessage,
						});
					} else {
						await interaction.reply({
							content: errorMessage,
							ephemeral: true,
						});
					}
				} catch (editError) {
					console.error(
						"Failed to send error message to the user:",
						editError,
					);
				}
			}
		}
	});
};

export default registerSyncCommand;
