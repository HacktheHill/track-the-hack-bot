import {
	Client,
	NewsChannel,
	PermissionFlagsBits,
	SlashCommandBuilder,
	TextChannel,
} from "discord.js";
import { Database, type ScheduledMessage } from "./database.js";

const SCHEDULER_WEBHOOK_NAME = "Track the Hack Scheduler";
const POLL_INTERVAL_MS = 15_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/;
const RELATIVE_TIME = /^(?:in\s+)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)$/i;
const LOCAL_TIME = /^(?:(today|tomorrow)\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;

export const scheduleCommand = new SlashCommandBuilder()
	.setName("schedule")
	.setDescription("Schedule a message in this channel")
	.addSubcommand(subcommand => subcommand
		.setName("create")
		.setDescription("Schedule a message using your current name and avatar")
		.addStringOption(option => option
			.setName("at")
			.setDescription("When to send: 2 hours, 10am, tomorrow 10am, or an ISO timestamp")
			.setRequired(true))
		.addStringOption(option => option
			.setName("message")
			.setDescription("Message to send")
			.setMaxLength(2000)
			.setRequired(true)))
	.addSubcommand(subcommand => subcommand
		.setName("list")
		.setDescription("List your pending scheduled messages"))
	.addSubcommand(subcommand => subcommand
		.setName("cancel")
		.setDescription("Cancel one of your pending scheduled messages")
		.addStringOption(option => option
			.setName("message")
			.setDescription("Choose the scheduled message to cancel")
			.setAutocomplete(true)
			.setRequired(true)));

function futureDate(value: Date, now: Date) {
	if (Number.isNaN(value.getTime())) throw new Error("That timestamp is not valid.");
	if (value.getTime() <= now.getTime()) throw new Error("The scheduled time must be in the future.");
	return value;
}

function timeZoneParts(date: Date, timeZone: string) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const values = Object.fromEntries(parts
		.filter(part => part.type !== "literal")
		.map(part => [part.type, Number(part.value)]));
	return values as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
}

function localDateTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string) {
	const desired = Date.UTC(year, month - 1, day, hour, minute, second);
	let candidate = desired;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const actual = timeZoneParts(new Date(candidate), timeZone);
		const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
		candidate += desired - actualAsUtc;
	}
	const result = new Date(candidate);
	const actual = timeZoneParts(result, timeZone);
	if (actual.year !== year || actual.month !== month || actual.day !== day
		|| actual.hour !== hour || actual.minute !== minute || actual.second !== second) {
		throw new Error("That local time does not exist because of a daylight-saving time change.");
	}
	return result;
}

export function parseScheduleTime(value: string, now = new Date(), timeZone = "America/Toronto") {
	const normalized = value.trim();
	const relative = RELATIVE_TIME.exec(normalized);
	if (relative) {
		const amount = Number(relative[1]);
		const unit = relative[2].toLowerCase();
		const multiplier = unit.startsWith("s") ? 1_000
			: unit.startsWith("m") ? 60_000
			: unit.startsWith("h") ? 60 * 60_000
			: 24 * 60 * 60_000;
		return futureDate(new Date(now.getTime() + amount * multiplier), now);
	}

	const local = LOCAL_TIME.exec(normalized);
	if (local) {
		const [, dayName, rawHour, rawMinute = "0", meridiem] = local;
		let hour = Number(rawHour);
		const minute = Number(rawMinute);
		if (minute > 59) throw new Error("That clock time is not valid.");
		if (meridiem) {
			if (hour < 1 || hour > 12) throw new Error("That clock time is not valid.");
			hour = hour % 12 + (meridiem.toLowerCase() === "pm" ? 12 : 0);
		} else if (hour > 23) {
			throw new Error("That clock time is not valid.");
		}
		const current = timeZoneParts(now, timeZone);
		const explicitDay = dayName?.toLowerCase();
		let localDate = new Date(Date.UTC(current.year, current.month - 1, current.day + (explicitDay === "tomorrow" ? 1 : 0)));
		let sendAt = localDateTimeToUtc(
			localDate.getUTCFullYear(), localDate.getUTCMonth() + 1, localDate.getUTCDate(), hour, minute, 0, timeZone,
		);
		if (!explicitDay && sendAt.getTime() <= now.getTime()) {
			localDate = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
			sendAt = localDateTimeToUtc(
				localDate.getUTCFullYear(), localDate.getUTCMonth() + 1, localDate.getUTCDate(), hour, minute, 0, timeZone,
			);
		}
		return futureDate(sendAt, now);
	}

	const match = ISO_TIMESTAMP.exec(normalized);
	if (match) {
		const [, date, hour, minute, second = "0", zone, offsetHour = "0", offsetMinute = "0"] = match;
		const calendarDate = new Date(`${date}T00:00:00Z`);
		const validDate = !Number.isNaN(calendarDate.getTime()) && calendarDate.toISOString().slice(0, 10) === date;
		const validTime = Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59;
		const validOffset = zone === "Z" || (Number(offsetHour) <= 14 && Number(offsetMinute) <= 59
			&& (Number(offsetHour) < 14 || Number(offsetMinute) === 0));
		if (!validDate || !validTime || !validOffset) throw new Error("That timestamp is not valid.");
		return futureDate(new Date(normalized), now);
	}

	throw new Error("Use `2 hours`, `10am`, `tomorrow 10am`, or an ISO timestamp with a timezone.");
}

function supportsWebhooks(channel: unknown): channel is TextChannel | NewsChannel {
	return channel instanceof TextChannel || channel instanceof NewsChannel;
}

async function schedulerWebhook(client: Client, channel: TextChannel | NewsChannel) {
	const webhooks = await channel.fetchWebhooks();
	const existing = webhooks.find(webhook =>
		webhook.name === SCHEDULER_WEBHOOK_NAME && webhook.owner?.id === client.user?.id,
	);
	if (existing) return existing;
	return channel.createWebhook({
		name: SCHEDULER_WEBHOOK_NAME,
		reason: "Deliver scheduled messages with the scheduler's saved Discord identity",
	});
}

export function scheduledWebhookPayload(message: ScheduledMessage) {
	return {
		content: message.content,
		username: message.schedulerName,
		avatarURL: message.schedulerAvatarUrl ?? undefined,
		allowedMentions: { parse: ["users", "roles"] as ("users" | "roles")[] },
	};
}

export function scheduledMessageChoices(messages: ScheduledMessage[], query = "", timeZone = "America/Toronto") {
	const normalizedQuery = query.trim().toLowerCase();
	return messages
		.filter(message => !normalizedQuery || message.content.toLowerCase().includes(normalizedQuery))
		.slice(0, 25)
		.map(message => {
			const preview = message.content.replace(/\s+/g, " ").slice(0, 65);
			const when = new Intl.DateTimeFormat("en-US", {
				timeZone,
				dateStyle: "medium",
				timeStyle: "short",
			}).format(new Date(message.sendAt));
			return { name: `${preview} • ${when}`.slice(0, 100), value: message.id };
		});
}

export async function deliverScheduledMessage(client: Client, message: ScheduledMessage) {
	const channel = await client.channels.fetch(message.channelId);
	if (!supportsWebhooks(channel)) throw new Error("The destination is no longer a supported text channel.");
	const webhook = await schedulerWebhook(client, channel);
	const sent = await webhook.send(scheduledWebhookPayload(message));
	return sent.id;
}

export async function dispatchDueScheduledMessages(client: Client, db: Database) {
	const messages = await db.claimDueScheduledMessages();
	for (const message of messages) {
		try {
			const discordMessageId = await deliverScheduledMessage(client, message);
			await db.markScheduledMessageSent(message.id, discordMessageId);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const retryAfterSeconds = message.attempts < MAX_DELIVERY_ATTEMPTS
				? Math.min(15 * 2 ** message.attempts, 15 * 60)
				: undefined;
			await db.markScheduledMessageDeliveryFailed(message.id, detail, retryAfterSeconds);
			console.error("Scheduled message delivery failed", {
				id: message.id,
				attempt: message.attempts,
				retrying: retryAfterSeconds !== undefined,
				error: detail,
			});
		}
	}
}

export function registerMessageScheduler(client: Client, db: Database | undefined, organizerGuildId: string, timeZone = "America/Toronto") {
	client.on("interactionCreate", async interaction => {
		if (interaction.isAutocomplete() && interaction.commandName === "schedule") {
			if (!db || interaction.options.getSubcommand() !== "cancel") {
				await interaction.respond([]);
				return;
			}
			try {
				const messages = await db.scheduledMessagesForUser(interaction.guildId ?? "", interaction.user.id);
				const focused = interaction.options.getFocused(true);
				await interaction.respond(scheduledMessageChoices(messages, String(focused.value), timeZone));
			} catch (error) {
				console.error("Scheduled message autocomplete failed", error);
				await interaction.respond([]);
			}
			return;
		}
		if (!interaction.isChatInputCommand() || interaction.commandName !== "schedule") return;
		if (interaction.guildId !== organizerGuildId || !interaction.guild) {
			await interaction.reply({ content: "Scheduling is only available in the Organizer server.", ephemeral: true });
			return;
		}
		if (!db) {
			await interaction.reply({ content: "Scheduling is unavailable because database integration is not configured.", ephemeral: true });
			return;
		}

		await interaction.deferReply({ ephemeral: true });
		try {
			const subcommand = interaction.options.getSubcommand();
			if (subcommand === "create") {
				const channel = interaction.channel;
				if (!supportsWebhooks(channel)) throw new Error("Messages can only be scheduled in a server text channel.");
				const botPermissions = channel.permissionsFor(interaction.guild.members.me!);
				if (!botPermissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageWebhooks])) {
					throw new Error("I need View Channel, Send Messages, and Manage Webhooks permissions in this channel.");
				}
				const member = await interaction.guild.members.fetch(interaction.user.id);
				if (!channel.permissionsFor(member)?.has(PermissionFlagsBits.SendMessages)) {
					throw new Error("You must be able to send messages in this channel to schedule one.");
				}
				const sendAt = parseScheduleTime(interaction.options.getString("at", true), new Date(), timeZone);
				await db.createScheduledMessage({
					guildId: interaction.guildId,
					channelId: channel.id,
					createdByDiscordId: interaction.user.id,
					schedulerName: member.displayName,
					schedulerAvatarUrl: member.displayAvatarURL({ extension: "png", size: 256 }),
					content: interaction.options.getString("message", true),
					sendAt,
				});
				await interaction.editReply(`Scheduled for <t:${Math.floor(sendAt.getTime() / 1000)}:F> in <#${channel.id}>.`);
				return;
			}

			if (subcommand === "list") {
				const messages = await db.scheduledMessagesForUser(interaction.guildId, interaction.user.id);
				if (!messages.length) {
					await interaction.editReply("You have no pending scheduled messages.");
					return;
				}
				const lines = messages.map(message => {
					const preview = message.content.replace(/\s+/g, " ").slice(0, 80);
					const timestamp = Math.floor(new Date(message.sendAt).getTime() / 1000);
					return `<t:${timestamp}:F> • <#${message.channelId}> • ${preview}`;
				});
				await interaction.editReply(lines.join("\n"));
				return;
			}

			const id = interaction.options.getString("message", true);
			const cancelled = await db.cancelScheduledMessage(id, interaction.guildId, interaction.user.id);
			await interaction.editReply(cancelled
				? "Cancelled scheduled message."
				: "That pending scheduled message was not found or does not belong to you.");
		} catch (error) {
			const detail = error instanceof Error ? error.message : "An unexpected error occurred.";
			await interaction.editReply(detail);
		}
	});

	if (!db) return;
	let dispatching = false;
	const dispatch = async () => {
		if (dispatching) return;
		dispatching = true;
		try {
			await dispatchDueScheduledMessages(client, db);
		} catch (error) {
			console.error("Scheduled message polling failed", error);
		} finally {
			dispatching = false;
		}
	};
	void dispatch();
	setInterval(() => void dispatch(), POLL_INTERVAL_MS).unref();
}
