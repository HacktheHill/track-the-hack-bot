import { z } from "zod";
import { minimizeText } from "./azure-openai.js";
import { corpusCaseSchema, sanitizeCorpusCase, type CorpusCase } from "./ai-corpus.js";

const messageUrlSchema = z.url().transform(value => {
	const url = new URL(value);
	const parts = url.pathname.split("/").filter(Boolean);
	if (url.protocol !== "https:" || url.hostname !== "discord.com" || url.search || url.hash || parts.length !== 4 || parts[0] !== "channels" || parts.slice(1).some(part => !/^\d+$/.test(part))) {
		throw new Error("Use canonical https://discord.com/channels/<guild>/<channel>/<message> links.");
	}
	return { guildId: parts[1]!, channelId: parts[2]!, messageId: parts[3]!, url: url.toString() };
});

const discordMessageSchema = z.object({
	id: z.string().regex(/^\d+$/),
	channel_id: z.string().regex(/^\d+$/),
	author: z.object({ id: z.string().regex(/^\d+$/), bot: z.boolean().optional() }),
	content: z.string(),
	timestamp: z.iso.datetime({ offset: true }),
	type: z.number().int(),
	mentions: z.array(z.object({ id: z.string().regex(/^\d+$/) })).default([]),
	attachments: z.array(z.object({
		id: z.string().regex(/^\d+$/),
		filename: z.string(),
		content_type: z.string().optional(),
		url: z.string(),
	})).default([]),
	message_reference: z.object({ message_id: z.string().regex(/^\d+$/).optional() }).optional(),
});

export interface DiscordCorpusRest {
	get(route: string): Promise<unknown>;
}

export type CorpusRecoveryPreview = {
	case: CorpusCase;
	addedMessageIds: string[];
	warnings: string[];
};

function recoveryError(message: string, statusCode = 400) {
	return Object.assign(new Error(message), { statusCode });
}

export function parseDiscordMessageUrl(value: string) {
	try {
		return messageUrlSchema.parse(value.trim());
	} catch {
		throw recoveryError("Use canonical https://discord.com/channels/<guild>/<channel>/<message> links.");
	}
}

function nextNumericId(prefix: string, values: Iterable<string>) {
	let maximum = 0;
	for (const value of values) {
		const match = new RegExp(`^${prefix}(\\d+)$`).exec(value);
		if (match) maximum = Math.max(maximum, Number(match[1]));
	}
	return () => `${prefix}${++maximum}`;
}

function canonicalMessageUrl(guildId: string, channelId: string, messageId: string) {
	return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export function createDiscordCorpusRecovery(options: {
	rest: DiscordCorpusRest;
	guildId: string;
	reviewer?: string;
	now?: () => string;
}) {
	const fetchMessage = async (channelId: string, messageId: string) => {
		try {
			return discordMessageSchema.parse(await options.rest.get(`/channels/${channelId}/messages/${messageId}`));
		} catch (error) {
			if (error instanceof z.ZodError) throw recoveryError(`Discord returned an invalid message for ${messageId}.`);
			throw recoveryError(`Discord message ${messageId} is unavailable or the bot cannot read its history.`);
		}
	};

	return async (value: CorpusCase, rawUrls: string[]): Promise<CorpusRecoveryPreview> => {
		if (!rawUrls.length || rawUrls.length > 40) throw recoveryError("Provide between 1 and 40 Discord message links.");
		const references = rawUrls.map(parseDiscordMessageUrl);
		if (references.some(reference => reference.guildId !== options.guildId)) throw recoveryError("Every recovered message must belong to the configured organizer guild.");
		const unique = new Map(references.map(reference => [reference.messageId, reference]));
		if (unique.size !== references.length) throw recoveryError("Remove duplicate Discord message links.");

		const existingReferences = value.reviewContext?.discordMessages ?? {};
		const existingByDiscordId = new Map(Object.entries(existingReferences).map(([id, reference]) => [reference.messageId, id]));
		const requested = [...unique.values()].filter(reference => !existingByDiscordId.has(reference.messageId));
		if (!requested.length) throw recoveryError("Every supplied Discord message is already present in this case.");

		const fetchedRequested = await Promise.all(requested.map(async reference => ({ reference, message: await fetchMessage(reference.channelId, reference.messageId) })));
		for (const { reference, message } of fetchedRequested) {
			if (message.id !== reference.messageId || message.channel_id !== reference.channelId) throw recoveryError(`Discord returned mismatched evidence for ${reference.messageId}.`);
			if (message.author.bot || ![0, 19].includes(message.type)) throw recoveryError(`Discord message ${message.id} is not a recoverable user message.`);
		}

		const warnings: string[] = [];
		const fetchedExisting = await Promise.all(Object.entries(existingReferences).map(async ([id, reference]) => {
			try { return { id, message: await fetchMessage(reference.channelId, reference.messageId) }; }
			catch { warnings.push(`Could not verify existing message ${id}; author alias reuse may be incomplete.`); return undefined; }
		}));
		const aliases = new Map<string, string>();
		for (const item of fetchedExisting) {
			const existing = item && value.window.messages.find(message => message.id === item.id);
			if (item && existing && !aliases.has(item.message.author.id)) aliases.set(item.message.author.id, existing.authorAlias);
		}
		const usedAliases = new Set(value.window.messages.map(message => message.authorAlias));
		let aliasNumber = 0;
		const aliasFor = (discordId: string) => {
			const existing = aliases.get(discordId);
			if (existing) return existing;
			let alias = "";
			do alias = `USER_${++aliasNumber}`; while (usedAliases.has(alias));
			usedAliases.add(alias);
			aliases.set(discordId, alias);
			return alias;
		};

		const nextMessageId = nextNumericId("m", value.window.messages.map(message => message.id));
		const attachmentIds = value.window.messages.flatMap(message => message.attachments?.map(attachment => attachment.id) ?? []);
		const nextAttachmentId = nextNumericId("a", attachmentIds);
		const corpusIds = new Map(existingByDiscordId);
		for (const { message } of fetchedRequested) corpusIds.set(message.id, nextMessageId());
		const focalTimestamp = new Date(value.window.messages.find(message => message.contextRole === "primary" || message.priority)?.timestamp ?? value.window.messages[0]!.timestamp).valueOf();
		const replyTargets = new Set(fetchedRequested.flatMap(item => item.message.message_reference?.message_id ?? []));
		for (const item of fetchedExisting) if (item?.message.message_reference?.message_id) replyTargets.add(item.message.message_reference.message_id);

		const added = fetchedRequested.map(({ reference, message }) => {
			for (const mention of message.mentions) aliasFor(mention.id);
			const id = corpusIds.get(message.id)!;
			const replyTo = message.message_reference?.message_id ? corpusIds.get(message.message_reference.message_id) : undefined;
			const contextRole = replyTargets.has(message.id) ? "reply_target" : new Date(message.timestamp).valueOf() < focalTimestamp ? "preceding" : "subsequent";
			if (message.attachments.length) warnings.push(`${id} contains attachment metadata only; attachment contents are not available to evaluation.`);
			return {
				id,
				authorAlias: aliasFor(message.author.id),
				text: minimizeText(message.content.replace(/<@!?(\d+)>/g, (_match, discordId: string) => aliasFor(discordId))),
				timestamp: new Date(message.timestamp).toISOString(),
				...(replyTo ? { replyTo } : {}),
				contextRole,
				...(message.attachments.length ? { attachments: message.attachments.map(attachment => {
					const attachmentId = nextAttachmentId();
					return {
						id: attachmentId,
						name: attachment.filename,
						...(attachment.content_type ? { contentType: attachment.content_type } : {}),
						url: `https://example.invalid/attachment/${attachmentId}`,
					};
				}) } : {}),
			};
		});
		const discordMessages = { ...existingReferences };
		for (const { reference, message } of fetchedRequested) {
			const id = corpusIds.get(message.id)!;
			discordMessages[id] = {
				guildId: options.guildId,
				channelId: reference.channelId,
				messageId: message.id,
				url: canonicalMessageUrl(options.guildId, reference.channelId, message.id),
			};
		}
		const addedMessageIds = added.map(message => message.id);
		const now = options.now?.() ?? new Date().toISOString();
		const preview = sanitizeCorpusCase(corpusCaseSchema.parse({
			...value,
			window: { ...value.window, messages: [...value.window.messages, ...added].sort((left, right) => left.timestamp.localeCompare(right.timestamp)) },
			reviewContext: {
				discordMessages,
				reconstruction: {
					recoveredAt: now,
					...(options.reviewer ? { recoveredBy: options.reviewer } : {}),
					...(value.origin.fingerprint ? { baseFingerprint: value.origin.fingerprint } : {}),
					addedMessageIds: [...new Set([...(value.reviewContext?.reconstruction?.addedMessageIds ?? []), ...addedMessageIds])],
				},
			},
			adjudication: { status: "pending", exclusionReasons: [], notes: value.adjudication.notes },
			updatedAt: now,
		}));
		return { case: preview, addedMessageIds, warnings };
	};
}
