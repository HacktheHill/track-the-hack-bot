import { Client } from "discord.js";
import { config } from "dotenv";

config();

const {
	ORGANIZER_GUILD_ID,
	COMMUNITY_GUILD_ID,
	COMMUNITY_GUILD_ORGANIZER_ROLE_ID,
} = process.env;

if (
	!ORGANIZER_GUILD_ID ||
	!COMMUNITY_GUILD_ID ||
	!COMMUNITY_GUILD_ORGANIZER_ROLE_ID
) {
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
						"Syncing organizer role and nicknames | Synchronisation du rôle d'organisateur et des surnoms",
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
				const communityOwner = communityGuild.ownerId;

				const errors = [];

				// Add Organizer role to members in the organizer server
				for (const [_, organizerMember] of organizerMembers) {
					try {
						const communityMember = communityMembers.get(
							organizerMember.id,
						);
						if (
							communityMember &&
							communityMember.id !== communityOwner
						) {
							if (
								!communityMember.roles.cache.has(
									COMMUNITY_GUILD_ORGANIZER_ROLE_ID,
								)
							) {
								await communityMember.roles.add(
									COMMUNITY_GUILD_ORGANIZER_ROLE_ID,
								);
							}
							await communityMember.setNickname(
								organizerMember.nickname,
							);
						}
					} catch (error) {
						errors.push(
							`Failed to sync ${organizerMember.user.tag}: ${(error as Error).message}`,
						);
					}
				}

				// Remove Organizer role from members not in the organizer server
				for (const [_, communityMember] of communityMembers) {
					try {
						if (
							communityMember.id !== communityOwner &&
							!organizerMembers.has(communityMember.id) &&
							communityMember.roles.cache.has(
								COMMUNITY_GUILD_ORGANIZER_ROLE_ID,
							)
						) {
							await communityMember.roles.remove(
								COMMUNITY_GUILD_ORGANIZER_ROLE_ID,
							);
						}
					} catch (error) {
						errors.push(
							`Failed to remove role from ${communityMember.user.tag}: ${(error as Error).message}`,
						);
					}
				}

				let finalMessage =
					"Organizer role and nicknames synced | Rôle d'organisateur et surnoms synchronisés";
				if (errors.length > 0) {
					finalMessage +=
						"\n\nSome errors occurred:\n" + errors.join("\n");
				}

				await interaction.editReply({
					content: finalMessage,
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
