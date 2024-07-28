import bodyParser from "body-parser";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	Client,
	GatewayIntentBits,
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
	PORT = 40000,
	DISCORD_TOKEN,
	GUILD_ID,
	HACKER_ROLE_ID,
	ORGANIZER_ROLE_ID,
	SECRET_KEY,
} = process.env;

if (
	!DISCORD_TOKEN ||
	!GUILD_ID ||
	!HACKER_ROLE_ID ||
	!ORGANIZER_ROLE_ID ||
	!SECRET_KEY
) {
	console.error("Missing environment variables");
	process.exit(1);
}

app.use(bodyParser.json());

app.post("/assign", async (req: Request, res: Response) => {
	const { discordUserId, secretKey } = req.body;

	if (secretKey !== SECRET_KEY) {
		return res.status(403).json({ error: "Invalid secret key" });
	}

	try {
		const guild = await client.guilds.fetch(GUILD_ID);
		const member = await guild.members.fetch(discordUserId);
		const role = guild.roles.cache.get(HACKER_ROLE_ID);

		if (!member || !role) {
			return res.status(404).json({ error: "User or role not found" });
		}

		await member.roles.add(role);
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

client.on("interactionCreate", async interaction => {
	if (!interaction.isCommand() && !interaction.isButton()) return;

	if (interaction.isCommand() && interaction.commandName === "verify") {
		const userId = interaction.user.id;
		const guild = await client.guilds.fetch(GUILD_ID);
		const member = await guild.members.fetch(userId);
		const isOrganizer = member.roles.cache.has(ORGANIZER_ROLE_ID);

		const link = `http://tracker.hackthehill.com/discord?id=${userId}`;

		const button = new ButtonBuilder()
			.setLabel("Get Verification Link")
			.setStyle(ButtonStyle.Link)
			.setURL(link);

		const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

		await interaction.reply({
			content: "Click the button below to verify your account:",
			components: [row],
			ephemeral: !isOrganizer,
		});
	}
});

client.login(DISCORD_TOKEN);
