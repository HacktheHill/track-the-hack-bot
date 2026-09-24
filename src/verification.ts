import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	Client,
	GuildMember,
	PermissionFlagsBits,
	TextChannel,
} from "discord.js";
import { config } from "dotenv";
import { getClient, isIntegrationReady } from "./bot.js";
import { VerificationStore } from "./verification-store.js";
import { createVerificationApp } from "./verification-api.js";
import { grantVerifiedHackerRole } from "./verification-role.js";

config();

const {
	PORT = 4000,
	COMMUNITY_GUILD_ID,
	COMMUNITY_GUILD_HACKER_ROLE_ID,
	COMMUNITY_GUILD_ORGANIZER_ROLE_ID,
	LOG_CHANNEL_ID,
	TRACK_THE_HACK_URL,
	INTERNAL_API_SECRET,
	DATABASE_URL,
} = process.env;

if (
	!COMMUNITY_GUILD_ID ||
	!COMMUNITY_GUILD_HACKER_ROLE_ID ||
	!COMMUNITY_GUILD_ORGANIZER_ROLE_ID ||
	!LOG_CHANNEL_ID ||
	!DATABASE_URL ||
	!INTERNAL_API_SECRET ||
	INTERNAL_API_SECRET.length < 32 ||
	!TRACK_THE_HACK_URL
) {
	console.error("Missing environment variables for verification");
	process.exit(1);
}

const log = async (client: Client, member: GuildMember) => {
	try {
		const guild = await client.guilds.fetch(COMMUNITY_GUILD_ID);
		const channel = await guild.channels.fetch(LOG_CHANNEL_ID);

		if (!channel || !(channel instanceof TextChannel)) {
			console.error("Log channel not found or is not a text channel");
			return;
		}

		if (
			!channel
				.permissionsFor(client.user!)
				?.has(PermissionFlagsBits.SendMessages)
		) {
			console.error(
				"Missing permissions to send messages in the log channel",
			);
			return;
		}

		await channel.send({
			content: `:white_check_mark: <@${member.id}> has been verified | <@${member.id}> a été vérifié`,
		});
		console.log(`${member.user.tag} has been verified`);
	} catch (error) {
		console.error(
			"An error occurred while sending the log message:",
			error,
		);
	}
};

const verificationStore = new VerificationStore(DATABASE_URL);
if (process.env.VERIFICATION_RUN_MIGRATIONS !== "false")
	await verificationStore.migrate();
// Fail startup if externally managed migrations were not applied.
await verificationStore.pool.query(
	"SELECT 1 FROM discord_participant_links LIMIT 1",
);
await verificationStore.pool.query(
	"SELECT 1 FROM discord_verification_challenges LIMIT 1",
);
await verificationStore.pool.query(
	"SELECT 1 FROM notification_delivery_receipts LIMIT 1",
);
await verificationStore.cleanupExpiredChallenges();
const challengeCleanup = setInterval(
	() => {
		void verificationStore
			.cleanupExpiredChallenges()
			.catch(() =>
				console.error("Expired verification challenge cleanup failed"),
			);
	},
	15 * 60 * 1000,
);
challengeCleanup.unref();

const app = createVerificationApp({
	secret: INTERNAL_API_SECRET,
	store: verificationStore,
	isReady: () => getClient().isReady() && isIntegrationReady(),
	grantRole: async discordId => {
		const client = getClient();
		await grantVerifiedHackerRole(
			client,
			COMMUNITY_GUILD_ID,
			COMMUNITY_GUILD_HACKER_ROLE_ID,
			discordId,
			member => log(client, member),
		);
	},
	sendDirectMessage: async (discordId, content) => {
		const user = await getClient().users.fetch(discordId);
		const message = await user.send({
			content,
			allowedMentions: { parse: [] },
		});
		return message.id;
	},
});
const server = app.listen(PORT, () =>
	console.log(`Server running on port ${PORT}`),
);
export async function closeVerification() {
	clearInterval(challengeCleanup);
	await new Promise<void>((resolve, reject) =>
		server.close(error => (error ? reject(error) : resolve())),
	);
	await verificationStore.close();
}

const getVerificationLinkButton = async (userId: string) => {
	const link = await verificationStore.createLink(
		TRACK_THE_HACK_URL,
		INTERNAL_API_SECRET,
		userId,
	);
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setLabel("Verification Link / Lien de vérification")
			.setStyle(ButtonStyle.Link)
			.setURL(link),
	);
};

const getVerificationLinkReply = async (userId: string) => ({
	content:
		"Your private link expires in five minutes. Activate your day-of participant access in the same browser first. | Votre lien privé expire dans cinq minutes. Activez d’abord votre accès de participant dans le même navigateur.",
	components: [await getVerificationLinkButton(userId)],
	ephemeral: true,
});

const getGenerateLinkButton = () =>
	new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId("generateLink")
			.setLabel(
				"Generate Verification Link | Générer un lien de vérification",
			)
			.setStyle(ButtonStyle.Primary),
	);

const getGenerateLinkReply = () => ({
	components: [getGenerateLinkButton()],
	ephemeral: false,
});

const registerVerificationCommand = (client: Client) => {
	client.on("interactionCreate", async interaction => {
		if (!interaction.isCommand() && !interaction.isButton()) return;
		if (interaction.guildId !== COMMUNITY_GUILD_ID) return;

		try {
			if (
				interaction.isCommand() &&
				interaction.commandName === "verify"
			) {
				await interaction.deferReply({ ephemeral: true });

				const userId = interaction.user.id;
				const guild = await client.guilds.fetch(COMMUNITY_GUILD_ID);
				const member = await guild.members.fetch(userId);
				const isOrganizer = member.roles.cache.has(
					COMMUNITY_GUILD_ORGANIZER_ROLE_ID,
				);

				if (isOrganizer) {
					await interaction.deleteReply();
					await interaction.followUp(getGenerateLinkReply());
				} else {
					await interaction.editReply(
						await getVerificationLinkReply(userId),
					);
				}
			}

			if (
				interaction.isButton() &&
				interaction.customId === "generateLink"
			) {
				await interaction.deferUpdate();

				const userId = interaction.user.id;

				await interaction.followUp(
					await getVerificationLinkReply(userId),
				);
			}
		} catch {
			console.error("Error generating verification link");
			try {
				const errorMessage =
					"There was an error handling this interaction. | Une erreur s'est produite lors du traitement de cette interaction.";
				if (interaction.replied || interaction.deferred) {
					await interaction.editReply({
						content: errorMessage,
						components: [],
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
	});
};

export default registerVerificationCommand;
