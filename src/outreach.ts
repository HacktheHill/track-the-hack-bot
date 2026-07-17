import { createHash, createHmac, randomUUID } from "node:crypto";

import {
	ApplicationCommandType,
	Client,
	ContextMenuCommandBuilder,
	Events,
	Message,
	PermissionFlagsBits,
} from "discord.js";

import type { OutreachConfig } from "./config.js";

const COMMAND_NAME = "Send as outreach evidence";
const ENDPOINT_PATH = "/api/internal/discord-evidence";

export const outreachEvidenceCommand = new ContextMenuCommandBuilder()
	.setName(COMMAND_NAME)
	.setType(ApplicationCommandType.Message);

export function normalizeExcerpt(content: string): string {
	const normalized = content.normalize("NFKC").replace(/\r\n/g, "\n").trim();
	if (!normalized) throw new Error("The selected message has no text content");
	return normalized.slice(0, 4_000);
}

export function createOutreachEnvelope(message: Message) {
	if (!message.guildId) throw new Error("The selected message is not in a guild");
	return {
		schemaVersion: 1 as const,
		guildId: message.guildId,
		channelId: message.channelId,
		messageId: message.id,
		author: {
			id: message.author.id,
			displayName:
				message.member?.displayName ??
				message.author.globalName ??
				message.author.displayName ??
				message.author.username,
		},
		occurredAt: message.createdAt.toISOString(),
		discordUrl: `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`,
		excerpt: normalizeExcerpt(message.content),
		entities: [],
		proposedInteractionType: "OTHER" as const,
		confidence: 0,
		redactionStatus: "REVIEW_REQUIRED" as const,
	};
}

export function signOutreachRequest(
	secret: string,
	method: string,
	path: string,
	timestamp: string,
	nonce: string,
	body: Buffer,
): string {
	const digest = createHash("sha256").update(body).digest("hex");
	return createHmac("sha256", secret)
		.update([method.toUpperCase(), path, timestamp, nonce, digest].join("\n"))
		.digest("hex");
}

export async function sendOutreachEvidence(
	config: OutreachConfig,
	envelope: ReturnType<typeof createOutreachEnvelope>,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const body = Buffer.from(JSON.stringify(envelope));
	const timestamp = new Date().toISOString();
	const nonce = randomUUID();
	const signature = signOutreachRequest(
		config.OUTREACH_DISCORD_SIGNING_SECRET,
		"POST",
		ENDPOINT_PATH,
		timestamp,
		nonce,
		body,
	);
	const response = await fetcher(new URL(ENDPOINT_PATH, config.OUTREACH_SERVICE_URL), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-ctn-service": "track-the-hack-bot",
			"x-ctn-key-id": config.OUTREACH_DISCORD_KEY_ID,
			"x-ctn-timestamp": timestamp,
			"x-ctn-nonce": nonce,
			"x-ctn-signature": signature,
		},
		body,
		signal: AbortSignal.timeout(10_000),
	});
	if (response.status !== 202) throw new Error("Outreach service rejected the evidence");
}

export function registerOutreachInteractions(client: Client, config: OutreachConfig | null) {
	client.on(Events.InteractionCreate, async interaction => {
		if (!interaction.isMessageContextMenuCommand() || interaction.commandName !== COMMAND_NAME) return;
		try {
			if (!config) throw new Error("Outreach evidence integration is not configured");
			if (interaction.guildId !== config.ORGANIZER_GUILD_ID) {
				throw new Error("This command is restricted to the organizer guild");
			}
			if (!config.allowedChannelIds.has(interaction.targetMessage.channelId)) {
				throw new Error("This channel is not approved for outreach evidence");
			}
			await interaction.deferReply({ ephemeral: true });
			const member = await interaction.guild?.members.fetch(interaction.user.id);
			if (
				!member ||
				(!member.roles.cache.has(config.ORGANIZER_GUILD_ORGANIZER_ROLE_ID) &&
					!member.permissions.has(PermissionFlagsBits.ManageGuild))
			) {
				throw new Error("Organizer permission is required");
			}
			await sendOutreachEvidence(config, createOutreachEnvelope(interaction.targetMessage));
			await interaction.editReply("Evidence sent to the outreach review queue.");
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unable to send outreach evidence";
			if (interaction.deferred || interaction.replied) await interaction.editReply(message);
			else await interaction.reply({ content: message, ephemeral: true });
		}
	});
}
