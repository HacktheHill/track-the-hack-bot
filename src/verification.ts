import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	Client,
	GuildMember,
	PermissionFlagsBits,
	TextChannel,
} from "discord.js";
import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import { config } from "dotenv";
import { getClient } from "./bot";

config();

const app = express();
app.use(bodyParser.json());

const {
	PORT = 4000,
	COMMUNITY_GUILD_ID,
	COMMUNITY_GUILD_HACKER_ROLE_ID,
	LOG_CHANNEL_ID,
	SECRET_KEY,
	TRACK_THE_HACK_URL,
} = process.env;

if (
	!COMMUNITY_GUILD_ID ||
	!COMMUNITY_GUILD_HACKER_ROLE_ID ||
	!LOG_CHANNEL_ID ||
	!SECRET_KEY ||
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

app.post("/verify", async (req: Request, res: Response) => {
	const { discordId, secretKey } = req.body;

	if (secretKey !== SECRET_KEY) {
		return res.status(403).json({ error: "Invalid secret key" });
	}

	try {
		const client = getClient();

		const guild = await client.guilds.fetch(COMMUNITY_GUILD_ID);
		const member = await guild.members.fetch(discordId);
		const role = guild.roles.cache.get(COMMUNITY_GUILD_HACKER_ROLE_ID);

		if (!member || !role) {
			return res.status(404).json({ error: "User or role not found" });
		}

		await member.roles.add(role);
		await log(client, member);

		return res.json({ status: "Success" });
	} catch (error) {
		console.error(error);
		return res.status(500).json({ error: "Internal server error" });
	}
});

app.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`);
});

const getVerificationLinkButton = (userId: string) => {
	const link = `${TRACK_THE_HACK_URL}/discord?id=${userId}`;
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setLabel("Verification Link / Lien de vérification")
			.setStyle(ButtonStyle.Link)
			.setURL(link),
	);
};

const getVerificationLinkReply = (userId: string) => ({
	content:
		"Here is your verification link | Voici votre lien de vérification",
	components: [getVerificationLinkButton(userId)],
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
					COMMUNITY_GUILD_HACKER_ROLE_ID,
				);

				if (isOrganizer) {
					await interaction.editReply(getGenerateLinkReply());
				} else {
					await interaction.editReply(
						getVerificationLinkReply(userId),
					);
				}
			}

			if (
				interaction.isButton() &&
				interaction.customId === "generateLink"
			) {
				await interaction.deferUpdate();

				const userId = interaction.user.id;

				await interaction.followUp(getVerificationLinkReply(userId));
			}
		} catch (error) {
			console.error("Error handling interaction:", error);
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
