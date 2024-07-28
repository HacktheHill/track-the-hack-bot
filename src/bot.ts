import bodyParser from "body-parser";
import { Client, GatewayIntentBits } from "discord.js";
import { config } from "dotenv";
import type { Request, Response } from "express";
import express from "express";

config();

const app = express();
const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const PORT = process.env.PORT ?? 4000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const HACKER_ROLE_ID = process.env.HACKER_ROLE_ID;
const SECRET_KEY = process.env.SECRET_KEY;

if (!DISCORD_TOKEN || !GUILD_ID || !HACKER_ROLE_ID || !SECRET_KEY) {
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

client.login(DISCORD_TOKEN);
