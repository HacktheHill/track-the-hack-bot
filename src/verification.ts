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
import { getClient, isIntegrationReady } from "./bot.js";
import { createHmac, timingSafeEqual } from "node:crypto";

config();

const app = express();
app.use(bodyParser.json());

const startedAt = new Date().toISOString();

const {
	PORT = 4000,
	COMMUNITY_GUILD_ID,
	COMMUNITY_GUILD_HACKER_ROLE_ID,
	COMMUNITY_GUILD_ORGANIZER_ROLE_ID,
	LOG_CHANNEL_ID,
	SECRET_KEY,
	TRACK_THE_HACK_URL,
	INTERNAL_API_SECRET,
	ALLOW_LEGACY_API_SECRET = "false",
} = process.env;

if (
	!COMMUNITY_GUILD_ID ||
	!COMMUNITY_GUILD_HACKER_ROLE_ID ||
	!COMMUNITY_GUILD_ORGANIZER_ROLE_ID ||
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
	const requestTimestamp = req.header("x-track-the-hack-timestamp");
	const requestSignature = req.header("x-track-the-hack-signature");
	const sharedSecret = INTERNAL_API_SECRET || SECRET_KEY;
	const timestamp = Number(requestTimestamp);
	const rawBody = JSON.stringify(req.body);
	const signedPayload = `${requestTimestamp ?? ""}.${rawBody}`;
	const expectedSignature = createHmac("sha256", sharedSecret)
		.update(signedPayload)
		.digest("hex");
	const signatureValid = Boolean(
		requestSignature &&
		/^[a-f0-9]{64}$/i.test(requestSignature) &&
		timingSafeEqual(
			Buffer.from(requestSignature, "utf8"),
			Buffer.from(expectedSignature, "utf8"),
		),
	);
	const timestampValid = Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp * 1000) <= 300_000;

	// Keep the legacy body secret during migration. The app should switch to the
	// timestamped HMAC headers before the old form is removed.
	const legacyAllowed = ALLOW_LEGACY_API_SECRET.toLowerCase() === "true";
	if (!signatureValid && !(legacyAllowed && secretKey && secretKey === SECRET_KEY)) {
		return res.status(403).json({ error: "Invalid secret key" });
	}
	if (requestSignature && !timestampValid) {
		return res.status(401).json({ error: "Expired request" });
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

app.get("/healthz", (_req, res) => {
	res.json({ status: "ok", startedAt });
});

app.get("/readyz", (_req, res) => {
	if (!getClient().isReady() || !isIntegrationReady()) {
		return res.status(503).json({ status: "not_ready" });
	}
	return res.json({ status: "ready" });
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
					COMMUNITY_GUILD_ORGANIZER_ROLE_ID,
				);

				if (isOrganizer) {
					await interaction.deleteReply();
					await interaction.followUp(getGenerateLinkReply());
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
