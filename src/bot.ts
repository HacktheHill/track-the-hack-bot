import bodyParser from "body-parser";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	Client,
	GatewayIntentBits,
	GuildMember,
	PermissionFlagsBits,
	TextChannel,
} from "discord.js";
import { config } from "dotenv";
import type { Request, Response } from "express";
import express from "express";

config();

const app = express();
const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const {
	PORT = 4000,
	DISCORD_TOKEN,
	GUILD_ID,
	HACKER_ROLE_ID,
	ORGANIZER_ROLE_ID,
	LOG_CHANNEL_ID,
	SECRET_KEY,
	TRACK_THE_HACK_URL,
} = process.env;

if (
	!DISCORD_TOKEN ||
	!GUILD_ID ||
	!HACKER_ROLE_ID ||
	!ORGANIZER_ROLE_ID ||
	!LOG_CHANNEL_ID ||
	!SECRET_KEY ||
	!TRACK_THE_HACK_URL
) {
	console.error("Missing environment variables");
	process.exit(1);
}

app.use(bodyParser.json());

const log = async (member: GuildMember) => {
	try {
		const guild = await client.guilds.fetch(GUILD_ID);
		const channel = await guild.channels.fetch(LOG_CHANNEL_ID);

		if (!channel) {
			console.error("Log channel not found");
			return;
		}

		if (!(channel instanceof TextChannel)) {
			console.error("Log channel is not a text channel");
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
			content: `:white_check_mark: <@${member.id}> has been verified`,
		});
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
		const guild = await client.guilds.fetch(GUILD_ID);
		const member = await guild.members.fetch(discordId);
		const role = guild.roles.cache.get(HACKER_ROLE_ID);

		if (!member || !role) {
			return res.status(404).json({ error: "User or role not found" });
		}

		await member.roles.add(role);
		await log(member);

		return res.json({ status: "Success" });
	} catch (error) {
		console.error(error);
		return res.status(500).json({ error: "Internal server error" });
	}
});

app.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`);
});

client.once("ready", () => {
	console.log(`Logged in as ${client.user?.tag ?? "Unknown"}`);
});

const getVerificationLinkButton = (userId: string) => {
	const link = `${TRACK_THE_HACK_URL}/discord?id=${userId}`;
	const linkButton = new ButtonBuilder()
		.setLabel("Verification Link / Lien de vérification")
		.setStyle(ButtonStyle.Link)
		.setURL(link);

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton);

	return row;
};

const getVerificationLinkReply = (userId: string) => ({
	content:
		"Here is your verification link | Voici votre lien de vérification",
	components: [getVerificationLinkButton(userId)],
	ephemeral: true,
});

const getGenerateLinkButton = () => {
	const generateButton = new ButtonBuilder()
		.setCustomId("generateLink")
		.setLabel(
			"Generate Verification Link | Générer un lien de vérification",
		)
		.setStyle(ButtonStyle.Primary);

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		generateButton,
	);

	return row;
};

const getGenerateLinkReply = () => ({
	components: [getGenerateLinkButton()],
	ephemeral: false,
});

client.on("interactionCreate", async interaction => {
	if (!interaction.isCommand() && !interaction.isButton()) return;

	if (interaction.isCommand() && interaction.commandName === "verify") {
		const userId = interaction.user.id;
		const guild = await client.guilds.fetch(GUILD_ID);
		const member = await guild.members.fetch(userId);
		const isOrganizer = member.roles.cache.has(ORGANIZER_ROLE_ID);

		if (isOrganizer) {
			await interaction.reply(getGenerateLinkReply());
		} else {
			await interaction.reply(getVerificationLinkReply(userId));
		}
	}

	if (interaction.isButton() && interaction.customId === "generateLink") {
		const userId = interaction.user.id;
		await interaction.reply(getVerificationLinkReply(userId));
	}
});

client.login(DISCORD_TOKEN);
