import { Client, GuildMember } from "discord.js";
import { config } from "dotenv";

config();

const {
	ORGANIZER_GUILD_ID,
	COMMUNITY_GUILD_ID,
	COMMUNITY_GUILD_ORGANIZER_ROLE_ID,
	ORGANIZER_GUILD_ORGANIZER_ROLE_ID,
} = process.env;

if (
	!ORGANIZER_GUILD_ID ||
	!COMMUNITY_GUILD_ID ||
	!COMMUNITY_GUILD_ORGANIZER_ROLE_ID ||
	!ORGANIZER_GUILD_ORGANIZER_ROLE_ID
) {
	console.error("Missing environment variables for sync");
	process.exit(1);
}

const registerSyncCommand = (client: Client) => {
	client.on("interactionCreate", async interaction => {
		if (!interaction.isCommand()) return;

		const { commandName } = interaction;

		if (commandName === "sync") {
			try {
				await interaction.reply({
					content:
						"Syncing organizer roles and nicknames... | Synchronisation des rôles et surnoms d'organisateur...",
					ephemeral: true,
				});

				const errors = await syncOrganizerRoleAndNicknames(client);

				let finalMessage =
					"Organizer roles and nicknames synced successfully. | Rôles et surnoms d'organisateur synchronisés avec succès.";
				if (errors.length > 0) {
					finalMessage +=
						"\n\nSome errors occurred: | Quelques erreurs se sont produites :\n" +
						errors.join("\n");
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

const syncMember = async ({
	organizerMember,
	communityMember,
	errors,
}: {
	organizerMember?: GuildMember;
	communityMember: GuildMember;
	errors: string[];
}) => {
	const isOrganizerGuildOrganizer = organizerMember?.roles.cache.has(
		ORGANIZER_GUILD_ORGANIZER_ROLE_ID,
	);
	const isCommunityGuildOrganizer = communityMember.roles.cache.has(
		COMMUNITY_GUILD_ORGANIZER_ROLE_ID,
	);
	const isOwner = communityMember.id === communityMember.guild.ownerId;

	try {
		if (!isOwner && organizerMember && isOrganizerGuildOrganizer) {
			if (!isCommunityGuildOrganizer) {
				await communityMember.roles.add(COMMUNITY_GUILD_ORGANIZER_ROLE_ID);
			}
			await communityMember.setNickname(organizerMember.nickname);
		} else if (!isOwner && !isOrganizerGuildOrganizer && isCommunityGuildOrganizer) {
			await communityMember.roles.remove(
				COMMUNITY_GUILD_ORGANIZER_ROLE_ID,
			);
		}
	} catch (error) {
		errors.push(
			`Failed to sync roles or nickname for ${
				communityMember.user.tag
			} | Échec de la synchronisation des rôles ou du surnom pour ${
				communityMember.user.tag
			}: ${(error as Error).message}`,
		);
	}
};

const syncGuildMembers = async ({
	communityMembers,
	organizerMembers,
	singleUserId,
	errors,
}: {
	communityMembers: Map<string, GuildMember>;
	organizerMembers: Map<string, GuildMember>;
	singleUserId?: string;
	errors: string[];
}) => {
	if (singleUserId) {
		const singleMember = communityMembers.get(singleUserId);
		if (singleMember) {
			const organizerMember = organizerMembers.get(singleUserId);
			await syncMember({
				organizerMember,
				communityMember: singleMember,
				errors,
			});
		}
	} else {
		for (const communityMember of communityMembers.values()) {
			const organizerMember = organizerMembers.get(communityMember.id);
			await syncMember({ organizerMember, communityMember, errors });
		}
	}
};

const syncOrganizerRoleAndNicknames = async (
	client: Client,
	singleUserId?: string,
) => {
	try {
		const organizerGuild = await client.guilds.fetch(ORGANIZER_GUILD_ID);
		const organizerMembers = await organizerGuild.members.fetch();

		const communityGuild = await client.guilds.fetch(COMMUNITY_GUILD_ID);
		const communityMembers = await communityGuild.members.fetch();

		const errors: string[] = [];

		await syncGuildMembers({
			communityMembers,
			organizerMembers,
			singleUserId,
			errors,
		});

		return errors;
	} catch (error) {
		console.error("Error during synchronization:", error);
		return [
			"An unexpected error occurred during synchronization. | Une erreur inattendue s'est produite lors de la synchronisation.",
		];
	}
};

const registerGuildMemberAddHandler = (client: Client) => {
	client.on("guildMemberAdd", async member => {
		if (member.guild.id === COMMUNITY_GUILD_ID) {
			console.log(
				`New member joined: ${member.user.tag}, syncing roles and nickname... | Nouveau membre rejoint : ${member.user.tag}, synchronisation des rôles et surnoms...`,
			);
			const errors = await syncOrganizerRoleAndNicknames(
				client,
				member.user.id,
			);
			if (errors.length > 0) {
				console.error(
					"Errors during sync for new member: | Erreurs lors de la synchronisation pour le nouveau membre :",
					errors.join("\n"),
				);
			}
		}
	});
};

export default registerSyncCommand;
export { registerGuildMemberAddHandler };
