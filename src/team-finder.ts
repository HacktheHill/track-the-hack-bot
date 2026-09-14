import {
	ChannelFlags, ChannelType, ChatInputCommandInteraction, Client, PermissionFlagsBits,
	type AnyThreadChannel, type ForumChannel, type GuildMember, type Message, type PrivateThreadChannel, type TextChannel, type Webhook,
	ThreadAutoArchiveDuration,
} from "discord.js";
import { loadTeamFinderConfig, type TeamFinderConfig } from "./config.js";
import {
	formatRankings, linkedDiscordIds, TeamFinderApi, TeamFinderApiError, type TeamFinderParty,
} from "./team-finder-api.js";
import {
	conversationKey, conversationMetadataMatches, conversationThreadName, findArchivedThread,
	dmDecision, finalTeamNameMatches, finalTeamThreadName, listingMarker, listingOperationKey,
	parseConversationMetadata, parseListingMetadata, parseListingReference, parseQuestionnaireReceipt, questionnaireReceipt,
	withTeamFinderKey,
} from "./team-finder-helpers.js";

const LISTING_WEBHOOK_NAME = "Team Finder Listings";
const GENERIC_ERROR = "Team Finder did not complete the request. Try again. | Team Finder n’a pas traité la demande. Réessayez.";
export const TEAM_FINDER_FORUM_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
	PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageThreads, PermissionFlagsBits.ManageWebhooks];
export const TEAM_FINDER_CONVERSATION_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.CreatePrivateThreads,
	PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageThreads];
class UserError extends Error {}
type ListingStep = "title" | "pitch" | "teammates" | "skills" | "confirm";
type ListingAnswerMessages = { title: Message; pitch: Message; teammates: Message; skills: Message };
type ListingDraft = { status: "cancel" } | { status: "timeout" } | {
	status: "publish"; title: string; pitch: string; teammates: number; skills: string; answers: ListingAnswerMessages;
};

export function listingContent(
	ownerId: string, pitch: string, teammates: number, skills?: string | null, sourceUrl?: string,
) {
	const lines = [
		`**Teammates wanted / Coéquipiers recherchés: ${teammates}**`,
		"", pitch.trim(),
	];
	if (skills?.trim()) lines.push("", "**Skills or interests / Compétences ou intérêts**", skills.trim());
	const source = sourceUrl ? ` · [Edit answers / Modifier les réponses](${sourceUrl})` : "";
	lines.push("", `${listingMarker(ownerId)}${source}`);
	return lines.join("\n");
}

export function parseListingAnswer(step: ListingStep, content: string) {
	const value = content.trim();
	const keyword = value.toLowerCase();
	if (keyword === "cancel") return { action: "cancel" } as const;
	if (step === "title") return value && value.length <= 100 && !/[\r\n]/.test(value)
		? { action: "accept", value } as const : { action: "retry" } as const;
	if (step === "pitch") return value && value.length <= 4_096
		? { action: "accept", value } as const : { action: "retry" } as const;
	if (step === "teammates") return /^[1-3]$/.test(value)
		? { action: "accept", value: Number(value) } as const : { action: "retry" } as const;
	if (step === "skills") {
		if (keyword === "skip") return { action: "accept", value: "" } as const;
		return value && value.length <= 1_024 ? { action: "accept", value } as const : { action: "retry" } as const;
	}
	return keyword === "publish" ? { action: "publish" } as const : { action: "retry" } as const;
}

export async function collectListingDraft(thread: PrivateThreadChannel, ownerId: string): Promise<ListingDraft> {
	const ask = async (step: ListingStep, prompt: string, retry: string) => {
		await thread.send(prompt);
		for (;;) {
			const reply = (await thread.awaitMessages({
				filter: message => message.author.id === ownerId, max: 1, time: 5 * 60_000,
			})).first();
			if (!reply) return { action: "timeout" } as const;
			const answer = parseListingAnswer(step, reply.content);
			if (answer.action !== "retry") return { ...answer, message: reply };
			await thread.send(retry);
		}
	};
	const title = await ask("title", "1/5 — Enter a public title. Use one line with 1 to 100 characters. Send `cancel` to stop.", "Enter one line with 1 to 100 characters. Send `cancel` to stop.");
	if (title.action === "cancel" || title.action === "timeout") return { status: title.action } as const;
	if (title.action !== "accept" || typeof title.value !== "string") throw new Error("Invalid questionnaire title");
	const pitch = await ask("pitch", "2/5 — Describe yourself or your project. You can use multiple lines. Send `cancel` to stop.", "Enter a pitch with 1 to 4,096 characters. Send `cancel` to stop.");
	if (pitch.action === "cancel" || pitch.action === "timeout") return { status: pitch.action } as const;
	if (pitch.action !== "accept" || typeof pitch.value !== "string") throw new Error("Invalid questionnaire pitch");
	const teammates = await ask("teammates", "3/5 — Enter the number of teammates that you need. Send `1`, `2`, or `3`. Send `cancel` to stop.", "Send `1`, `2`, or `3`. Send `cancel` to stop.");
	if (teammates.action === "cancel" || teammates.action === "timeout") return { status: teammates.action } as const;
	if (teammates.action !== "accept" || typeof teammates.value !== "number") throw new Error("Invalid questionnaire teammate count");
	const skills = await ask("skills", "4/5 — Enter your skills or interests. You can use multiple lines. Send `skip` to omit this answer. Send `cancel` to stop.", "Enter 1 to 1,024 characters. Send `skip` to omit this answer. Send `cancel` to stop.");
	if (skills.action === "cancel" || skills.action === "timeout") return { status: skills.action } as const;
	if (skills.action !== "accept" || typeof skills.value !== "string") throw new Error("Invalid questionnaire skills");
	await thread.send({
		content: `5/5 — Review the public listing: **${title.value}**\n\n${listingContent(ownerId, pitch.value, teammates.value, skills.value)}`,
		allowedMentions: { parse: [] },
	});
	const confirmation = await ask("confirm", "Send `publish` to publish the listing. Send `cancel` to stop.", "Send `publish` or `cancel`.");
	if (confirmation.action === "cancel" || confirmation.action === "timeout") return { status: confirmation.action } as const;
	if (confirmation.action !== "publish") throw new Error("Invalid questionnaire confirmation");
	return {
		status: "publish", title: title.value, pitch: pitch.value, teammates: teammates.value, skills: skills.value,
		answers: { title: title.message, pitch: pitch.message, teammates: teammates.message, skills: skills.message },
	} as const;
}

export async function managedListingWebhook(forum: ForumChannel, botId: string) {
	return withTeamFinderKey(`webhook:${forum.id}`, async () => {
		const matches = [...(await forum.fetchWebhooks()).values()].filter(webhook =>
			webhook.isIncoming() && webhook.channelId === forum.id
			&& webhook.owner?.id === botId && webhook.name === LISTING_WEBHOOK_NAME);
		if (matches.length > 1) throw new UserError("Delete the duplicate Team Finder webhooks. | Supprimez les webhooks Team Finder en double.");
		const webhook = matches[0] ?? await forum.createWebhook({
			name: LISTING_WEBHOOK_NAME, reason: "Team Finder public listings",
		});
		if (!webhook.token) throw new Error("Managed Team Finder webhook has no token");
		return webhook;
	});
}

export async function authenticatedListingOwner(thread: AnyThreadChannel, webhookId: string, forumId: string, guildId: string) {
	if (thread.type !== ChannelType.PublicThread || thread.parentId !== forumId || thread.guildId !== guildId) return null;
	const starter = await thread.fetchStarterMessage().catch(error => {
		if (error && typeof error === "object" && "code" in error && error.code === 10008) return null;
		throw error;
	});
	if (!starter || starter.webhookId !== webhookId || starter.author.id !== webhookId) return null;
	return parseListingMetadata(starter.content)?.ownerId ?? null;
}

export async function findListingThread(forum: ForumChannel, ownerId: string, webhookId: string) {
	const matches = async (thread: AnyThreadChannel) => !thread.locked
		&& await authenticatedListingOwner(thread, webhookId, forum.id, forum.guildId) === ownerId;
	const active = await forum.threads.fetchActive();
	for (const thread of active.threads.values()) if (await matches(thread)) return thread;
	return findArchivedThread(
		before => forum.threads.fetchArchived({ type: "public", limit: 100, ...(before ? { before } : {}) }),
		matches,
	);
}

export async function updateListingThread(thread: AnyThreadChannel, webhook: Webhook, title: string, content: string) {
	if (thread.archived) await thread.setArchived(false);
	const starter = await thread.fetchStarterMessage();
	if (!starter) throw new UserError("Team Finder cannot read your listing message. | Team Finder ne peut pas lire le message de votre annonce.");
	await webhook.editMessage(starter.id, { threadId: thread.id, content, embeds: [], allowedMentions: { parse: [] } });
	await thread.setName(title);
}

export async function closeListingThread(thread: AnyThreadChannel) {
	await thread.edit({ locked: true, archived: true });
}

export async function upsertListingThread(
	forum: ForumChannel, owner: GuildMember, botId: string, title: string,
	pitch: string, teammates: number, skills?: string | null, sourceUrl?: string,
) {
	const webhook = await managedListingWebhook(forum, botId);
	let thread = await findListingThread(forum, owner.id, webhook.id);
	const updated = Boolean(thread);
	const content = listingContent(owner.id, pitch, teammates, skills, sourceUrl);
	if (thread) await updateListingThread(thread, webhook, title, content);
	else {
		if (forum.flags.has(ChannelFlags.RequireTag)) {
			throw new UserError("The Team Finder forum requires a tag. The bot has no configured tag. | Le forum Team Finder exige une étiquette. Le bot n’en a aucune configurée.");
		}
		const starter = await webhook.send({
			threadName: title, username: owner.displayName, avatarURL: owner.displayAvatarURL(),
			content, allowedMentions: { parse: [] },
		});
		const created = await forum.guild.channels.fetch(starter.channelId);
		if (!created?.isThread() || created.type !== ChannelType.PublicThread || created.parentId !== forum.id) {
			throw new Error("Managed webhook did not create a forum thread");
		}
		thread = created;
	}
	return { thread, updated };
}

export function authenticConversationThread(
	thread: AnyThreadChannel, channel: TextChannel,
	listingId: string, ownerId: string, requesterId: string, botId: string,
) {
	return thread.type === ChannelType.PrivateThread && thread.parentId === channel.id
		&& thread.guildId === channel.guildId && thread.ownerId === botId
		&& conversationMetadataMatches(thread.name, listingId, ownerId, requesterId);
}

function conversationNameCollision(name: string, key: string) {
	return name === key || name.startsWith(`${key}--`);
}

export async function findOrCreatePrivateConversation(
	channel: TextChannel, listingId: string, ownerId: string, requesterId: string, botId: string,
) {
	const key = conversationKey(listingId, ownerId, requesterId);
	const name = conversationThreadName(listingId, ownerId, requesterId);
	const inspect = (thread: AnyThreadChannel) => {
		if (!conversationNameCollision(thread.name, key)) return false;
		if (!authenticConversationThread(thread, channel, listingId, ownerId, requesterId, botId)) {
			throw new UserError("Team Finder found a conflicting private thread. Contact an organizer. | Team Finder a trouvé un fil privé en conflit. Contactez un organisateur.");
		}
		return true;
	};
	const active = await channel.threads.fetchActive();
	let activeMatch: PrivateThreadChannel | undefined;
	for (const thread of active.threads.values()) if (inspect(thread)) {
		if (activeMatch) throw new UserError("Team Finder found duplicate private threads. Contact an organizer. | Team Finder a trouvé des fils privés en double. Contactez un organisateur.");
		activeMatch = thread as PrivateThreadChannel;
	}
	if (activeMatch) return { thread: activeMatch, created: false };
	const archived = await findArchivedThread(
		before => channel.threads.fetchArchived({ type: "private", fetchAll: true, limit: 100, ...(before ? { before } : {}) }),
		inspect,
	);
	if (archived) return { thread: archived as PrivateThreadChannel, created: false };
	const thread = await channel.threads.create({
		name, type: ChannelType.PrivateThread, invitable: false,
		autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
		reason: "Team Finder private conversation",
	}) as PrivateThreadChannel;
	if (!authenticConversationThread(thread, channel, listingId, ownerId, requesterId, botId)) throw new Error("Invalid created Team Finder thread");
	return { thread, created: true };
}

export async function preparePrivateConversation(thread: PrivateThreadChannel, ownerId: string, requesterId: string, botId: string) {
	return preparePrivateThread(thread, [ownerId, requesterId], botId);
}

export async function preparePrivateThread(thread: PrivateThreadChannel, participantIds: string[], botId: string) {
	const allowed = new Set([...participantIds, botId]);
	const memberIds = new Set<string>();
	let after: string | undefined;
	for (;;) {
		const page = await thread.members.fetch({ withMember: true, limit: 100, cache: false, ...(after ? { after } : {}) });
		for (const id of page.keys()) memberIds.add(id);
		if (page.size < 100) break;
		const next = [...page.keys()].at(-1);
		if (!next || next === after) throw new Error("Thread member pagination did not advance");
		after = next;
	}
	if (thread.archived) await thread.setArchived(false);
	for (const id of memberIds) if (!allowed.has(id)) await thread.members.remove(id);
	if (thread.locked) await thread.setLocked(false);
	await thread.setInvitable(false);
	await Promise.all([...allowed].filter(id => id !== botId).map(id => thread.members.add(id)));
}

export async function registerInterest(
	api: TeamFinderApi, channel: TextChannel, listingId: string, ownerId: string, requesterId: string, botId: string,
) {
	const result = await findOrCreatePrivateConversation(channel, listingId, ownerId, requesterId, botId);
	try {
		const request = await api.interest(requesterId, ownerId, listingId, result.thread.id);
		const [ownerParty, requesterParty] = await Promise.all([api.resolve(ownerId), api.resolve(requesterId)]);
		await preparePrivateThread(
			result.thread, [...new Set([...linkedDiscordIds(ownerParty), ...linkedDiscordIds(requesterParty)])], botId,
		);
		return { ...result, request, ownerParty, requesterParty };
	} catch (error) {
		if (result.created) await result.thread.delete("Team Finder interest registration failed").catch(() => undefined);
		throw error;
	}
}

export async function authenticatedDecisionConversation(
	thread: AnyThreadChannel, forum: ForumChannel, channel: TextChannel, webhookId: string, botId: string,
) {
	const metadata = parseConversationMetadata(thread.name);
	if (!metadata) return null;
	const listing = await forum.guild.channels.fetch(metadata.listingId).catch(() => null);
	if (!listing?.isThread()) return null;
	const ownerId = await authenticatedListingOwner(listing, webhookId, forum.id, forum.guildId);
	if (!ownerId || !metadata.userIds.includes(ownerId)) return null;
	const requesterId = metadata.userIds.find(id => id !== ownerId);
	if (!requesterId || !authenticConversationThread(
		thread, channel, metadata.listingId, ownerId, requesterId, botId,
	)) return null;
	return { thread: thread as PrivateThreadChannel, listing, ownerId, requesterId };
}

export function authenticFinalTeamThread(
	thread: AnyThreadChannel, channel: TextChannel, teamName: string, botId: string,
) {
	return thread.type === ChannelType.PrivateThread && thread.parentId === channel.id
		&& thread.guildId === channel.guildId && thread.ownerId === botId
		&& finalTeamNameMatches(thread.name, teamName);
}

export async function findOrCreateFinalTeamThread(
	channel: TextChannel, teamName: string, conversationId: string, botId: string,
) {
	const name = finalTeamThreadName(teamName);
	const inspect = (thread: AnyThreadChannel) => {
		if (!finalTeamNameMatches(thread.name, teamName)) return false;
		if (!authenticFinalTeamThread(thread, channel, teamName, botId)) {
			throw new UserError("Team Finder found a conflicting final team thread. Contact an organizer.");
		}
		return true;
	};
	const active = await channel.threads.fetchActive();
	const activeMatches = [...active.threads.values()].filter(inspect);
	if (activeMatches.length > 1) throw new UserError("Team Finder found duplicate final team threads. Contact an organizer.");
	if (activeMatches[0]) {
		const thread = activeMatches[0] as PrivateThreadChannel;
		if (thread.name !== name) await thread.setName(name);
		return { thread, created: false };
	}
	const archived = await findArchivedThread(
		before => channel.threads.fetchArchived({ type: "private", fetchAll: true, limit: 100, ...(before ? { before } : {}) }),
		inspect,
	);
	if (archived) {
		const thread = archived as PrivateThreadChannel;
		if (thread.archived) await thread.setArchived(false);
		if (thread.name !== name) await thread.setName(name);
		return { thread, created: false };
	}
	const thread = await channel.threads.create({
		name, type: ChannelType.PrivateThread, invitable: false,
		autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek, reason: "Team Finder final team",
	}) as PrivateThreadChannel;
	if (!authenticFinalTeamThread(thread, channel, teamName, botId)) throw new Error("Invalid created final team thread");
	return { thread, created: true };
}

export function decrementedListingContent(content: string, count: number) {
	const pattern = /^\*\*Teammates wanted \/ Coéquipiers recherchés: ([0-3])\*\*/;
	const match = pattern.exec(content);
	const current = Number(match?.[1]);
	if (!Number.isInteger(current) || current < 1 || current > 3) throw new Error("Team Finder listing has an invalid slot count");
	const remaining = Math.max(0, current - count);
	return { content: content.replace(pattern, `**Teammates wanted / Coéquipiers recherchés: ${remaining}**`), remaining };
}

export async function updateListingAfterAcceptance(
	listing: AnyThreadChannel, webhook: Webhook, acceptedTeamSize: number, priorOwnerPartySize: number,
) {
	if (listing.locked) return { remaining: 0, closed: true };
	if (listing.archived) await listing.setArchived(false);
	const starter = await listing.fetchStarterMessage();
	if (!starter?.content) throw new Error("Team Finder cannot read the accepted listing");
	const { content, remaining } = decrementedListingContent(starter.content, acceptedTeamSize - priorOwnerPartySize);
	await webhook.editMessage(starter.id, { threadId: listing.id, content, embeds: [], allowedMentions: { parse: [] } });
	const closed = remaining === 0 || acceptedTeamSize >= 4;
	if (closed) await closeListingThread(listing);
	return { remaining, closed };
}

function partySize(party: TeamFinderParty) {
	return party.team?.members.length ?? 1;
}

export async function acceptTeamRequest(input: {
	api: TeamFinderApi; channel: TextChannel; conversation: PrivateThreadChannel; listing: AnyThreadChannel;
	webhook: Webhook; ownerId: string; requesterId: string; actorId: string; botId: string; teamName?: string;
}) {
	const [ownerParty, requesterParty] = await Promise.all([
		input.api.resolve(input.ownerId), input.api.resolve(input.requesterId),
	]);
	const predictedName = ownerParty.team?.name ?? requesterParty.team?.name ?? input.teamName?.trim();
	if (!predictedName) throw new UserError("Set team_name because both parties are solo.");
	const participantIds = [...new Set([...linkedDiscordIds(ownerParty), ...linkedDiscordIds(requesterParty)])];
	if (partySize(ownerParty) + partySize(requesterParty) > 4) {
		throw new UserError("The combined team cannot have more than four hackers.");
	}
	const final = await findOrCreateFinalTeamThread(
		input.channel, predictedName, input.conversation.id, input.botId,
	);
	await preparePrivateThread(final.thread, participantIds, input.botId);
	let accepted;
	try {
		accepted = await input.api.accept(input.actorId, input.conversation.id, input.teamName);
	} catch (error) {
		if (final.created) await final.thread.delete("Team Finder acceptance failed").catch(() => undefined);
		throw error;
	}
	await final.thread.setName(finalTeamThreadName(accepted.team.name));
	await preparePrivateThread(
		final.thread, accepted.team.members.flatMap(member => member.discordId ? [member.discordId] : []), input.botId,
	);
	const recent = final.created ? null : await final.thread.messages.fetch({ limit: 1 });
	if (final.created || recent?.size === 0) await final.thread.send({
		content: `Welcome to **${accepted.team.name}**. This is your private final team thread.`,
		allowedMentions: { parse: [] },
	});
	const listing = await updateListingAfterAcceptance(
		input.listing, input.webhook, accepted.team.members.length, partySize(ownerParty),
	);
	return { ...accepted, finalThread: final.thread, listing };
}

async function checkedContext(interaction: ChatInputCommandInteraction, config: TeamFinderConfig) {
	const guild = interaction.guild;
	if (!guild || interaction.guildId !== config.COMMUNITY_GUILD_ID) throw new UserError("Use this command in the community server. | Utilisez cette commande dans le serveur communautaire.");
	const member = await guild.members.fetch(interaction.user.id).catch(() => null);
	if (!member?.roles.cache.has(config.COMMUNITY_GUILD_HACKER_ROLE_ID)) throw new UserError("Get the verified Hacker role before you use Team Finder. | Obtenez le rôle Hacker vérifié avant d’utiliser Team Finder.");
	const [forum, conversations] = await Promise.all([
		guild.channels.fetch(config.TEAM_FINDER_FORUM_CHANNEL_ID), guild.channels.fetch(config.TEAM_FINDER_CONVERSATION_CHANNEL_ID),
	]);
	if (!forum || forum.type !== ChannelType.GuildForum || !conversations || conversations.type !== ChannelType.GuildText) throw new UserError("Team Finder has incorrect channel settings. Contact an organizer. | Les paramètres des canaux Team Finder sont incorrects. Contactez un organisateur.");
	const botMember = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
	if (!botMember || !forum.permissionsFor(botMember)?.has(TEAM_FINDER_FORUM_PERMISSIONS)
		|| !conversations.permissionsFor(botMember)?.has(TEAM_FINDER_CONVERSATION_PERMISSIONS)) throw new UserError("The bot does not have the required channel permissions. Contact an organizer. | Le bot n’a pas les permissions requises. Contactez un organisateur.");
	return { forum, conversations, member };
}

async function post(
	interaction: ChatInputCommandInteraction, forum: ForumChannel, conversations: TextChannel, owner: GuildMember, botId: string,
) {
	const session = await conversations.threads.create({
		name: "Team Finder questionnaire",
		type: ChannelType.PrivateThread, invitable: false, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
		reason: "Team Finder guided listing",
	}) as PrivateThreadChannel;
	await session.members.add(interaction.user.id);
	await interaction.editReply(`Open the private Team Finder questionnaire: ${session.url}`);
	const draft = await collectListingDraft(session, interaction.user.id);
	if (draft.status === "cancel") return void await session.send("Team Finder canceled the questionnaire. Team Finder did not publish a listing.");
	if (draft.status === "timeout") return void await session.send("The time limit expired. Team Finder did not publish a listing.");
	await withTeamFinderKey(listingOperationKey(interaction.user.id), async () => {
		const { thread, updated } = await upsertListingThread(
			forum, owner, botId, draft.title, draft.pitch, draft.teammates, draft.skills, session.url,
		);
		await session.send(questionnaireReceipt(thread.url, {
			title: draft.answers.title.url, pitch: draft.answers.pitch.url,
			teammates: draft.answers.teammates.url, skills: draft.answers.skills.url,
		}));
		if (updated) await session.send("Team Finder updated your existing public listing.");
	});
}

export async function syncQuestionnaireEdit(
	message: Message, forum: ForumChannel, webhook: Webhook, botId: string,
) {
	if (message.author.bot || message.webhookId || message.guildId !== forum.guildId) return false;
	const thread = message.channel;
	if (!thread.isThread() || thread.type !== ChannelType.PrivateThread || thread.ownerId !== botId) return false;
	const history = await thread.messages.fetch({ limit: 100 });
	const receipts = [...history.values()]
		.filter(item => item.author.id === botId)
		.map(item => parseQuestionnaireReceipt(item.content))
		.filter(receipt => receipt !== null);
	if (receipts.length === 0) return false;
	if (receipts.length > 1) throw new UserError("This questionnaire has more than one listing receipt. Contact an organizer.");
	const receipt = receipts[0]!;
	if (receipt.guildId !== message.guildId || receipt.channelId !== thread.id) return false;
	if (!Object.values(receipt.answers).includes(message.id)) return false;
	const listing = await forum.guild.channels.fetch(receipt.listingId).catch(() => null);
	if (!listing?.isThread()) throw new UserError("Team Finder cannot find the public listing.");
	const ownerId = await authenticatedListingOwner(listing, webhook.id, forum.id, forum.guildId);
	if (ownerId !== message.author.id) throw new UserError("Only the listing owner can edit these answers.");
	const starter = await listing.fetchStarterMessage();
	const sourceLink = `[Edit answers / Modifier les réponses](${thread.url})`;
	if (!starter?.content.includes(sourceLink)) {
		throw new UserError("This questionnaire no longer controls the public listing.");
	}
	const answers = await Promise.all([
		thread.messages.fetch(receipt.answers.title), thread.messages.fetch(receipt.answers.pitch),
		thread.messages.fetch(receipt.answers.teammates), thread.messages.fetch(receipt.answers.skills),
	]);
	if (answers.some(answer => answer.author.id !== ownerId)) throw new UserError("A saved answer has a different author.");
	const [title, pitch, teammates, skills] = [
		parseListingAnswer("title", answers[0]!.content), parseListingAnswer("pitch", answers[1]!.content),
		parseListingAnswer("teammates", answers[2]!.content), parseListingAnswer("skills", answers[3]!.content),
	];
	if (title.action !== "accept" || pitch.action !== "accept" || teammates.action !== "accept" || skills.action !== "accept") {
		throw new UserError("The edited answer is invalid. Restore a valid answer and edit it again.");
	}
	await updateListingThread(
		listing, webhook, title.value as string,
		listingContent(ownerId, pitch.value as string, teammates.value as number, skills.value as string, thread.url),
	);
	return true;
}

async function referencedListing(interaction: ChatInputCommandInteraction, forum: ForumChannel, threadId: string, webhookId: string) {
	const thread = await interaction.guild!.channels.fetch(threadId).catch(() => null);
	if (!thread?.isThread() || thread.locked) throw new UserError("Paste the link for an open Team Finder listing. | Collez le lien d’une annonce Team Finder ouverte.");
	const ownerId = await authenticatedListingOwner(thread, webhookId, forum.id, forum.guildId);
	if (!ownerId) throw new UserError("Paste a listing that Team Finder created. | Collez une annonce créée par Team Finder.");
	return { thread, ownerId };
}

async function dm(
	interaction: ChatInputCommandInteraction, forum: ForumChannel, channel: TextChannel,
	botId: string, config: TeamFinderConfig, api: TeamFinderApi,
) {
	const reference = parseListingReference(interaction.options.getString("listing", true));
	if (!reference || reference.guildId && reference.guildId !== config.COMMUNITY_GUILD_ID) throw new UserError("Paste a valid Discord link for a listing in this server. | Collez un lien Discord valide pour une annonce de ce serveur.");
	const webhook = await managedListingWebhook(forum, botId);
	const initial = await referencedListing(interaction, forum, reference.threadId, webhook.id);
	if (dmDecision(initial.ownerId, interaction.user.id) === "self") throw new UserError("Choose another hacker’s listing. | Choisissez l’annonce d’un autre hacker.");
	await withTeamFinderKey(listingOperationKey(initial.ownerId), async () => {
		const current = await referencedListing(interaction, forum, reference.threadId, webhook.id);
		if (current.ownerId !== initial.ownerId) throw new UserError("The listing changed. Run the command again. | L’annonce a changé. Exécutez la commande de nouveau.");
		await withTeamFinderKey(`conversation:${conversationKey(current.thread.id, current.ownerId, interaction.user.id)}`, async () => {
			const owner = await interaction.guild!.members.fetch(current.ownerId).catch(() => null);
			if (!owner || owner.user.bot) throw new UserError("The listing owner is not in the server. | L’auteur de l’annonce n’est pas dans le serveur.");
			const result = await registerInterest(
				api, channel, current.thread.id, current.ownerId, interaction.user.id, botId,
			);
			const recent = result.created ? null : await result.thread.messages.fetch({ limit: 1 });
			if (result.created || recent?.size === 0) await result.thread.send({
				content: `<@${interaction.user.id}> registered interest in <@${current.ownerId}>'s listing. Use this private thread for the request.`,
				allowedMentions: { parse: [], users: [interaction.user.id, current.ownerId] },
			});
			await interaction.editReply(`Open the private conversation: ${result.thread.url}\nOuvrez la conversation privée : ${result.thread.url}`);
		});
	});
}

async function decisionContext(
	interaction: ChatInputCommandInteraction, forum: ForumChannel, conversations: TextChannel, botId: string,
) {
	const thread = await interaction.guild!.channels.fetch(interaction.channelId).catch(() => null);
	if (!thread?.isThread()) throw new UserError("Use this command in its private Team Finder conversation.");
	const webhook = await managedListingWebhook(forum, botId);
	const context = await authenticatedDecisionConversation(thread, forum, conversations, webhook.id, botId);
	if (!context) throw new UserError("Use this command in an authentic private Team Finder conversation.");
	return { ...context, webhook };
}

async function rankings(interaction: ChatInputCommandInteraction, api: TeamFinderApi) {
	const [requester, owner] = await Promise.all([
		api.list(interaction.user.id, "requester"), api.list(interaction.user.id, "owner"),
	]);
	await interaction.editReply(formatRankings(requester.requests, owner.requests));
}

async function requestAction(
	interaction: ChatInputCommandInteraction, forum: ForumChannel, conversations: TextChannel,
	botId: string, api: TeamFinderApi, action: "rank" | "offer" | "accept" | "reject" | "decline",
) {
	const context = await decisionContext(interaction, forum, conversations, botId);
	await withTeamFinderKey(`decision:${context.thread.id}`, async () => {
		if (action === "rank") {
			const position = interaction.options.getInteger("position", true);
			await api.rank(interaction.user.id, context.thread.id, position);
			return void await interaction.editReply(`Team Finder set this request to position ${position} in your ranking.`);
		}
		if (action === "accept") {
			const teamName = interaction.options.getString("team_name") ?? undefined;
			const result = await acceptTeamRequest({
				api, channel: conversations, conversation: context.thread, listing: context.listing,
				webhook: context.webhook, ownerId: context.ownerId, requesterId: context.requesterId,
				actorId: interaction.user.id, botId, teamName,
			});
			await context.thread.send({
				content: `<@${interaction.user.id}> accepted the offer. Open the final **${result.team.name}** thread: ${result.finalThread.url}`,
				allowedMentions: { parse: [], users: [interaction.user.id] },
			});
			await interaction.editReply(`Team Finder created **${result.team.name}**: ${result.finalThread.url}`);
			await context.thread.edit({ locked: true, archived: true });
			return;
		}
		await api.decide(action, interaction.user.id, context.thread.id);
		const messages = {
			offer: "sent a team offer. The requester captain can accept or decline it.",
			reject: "rejected the team request.",
			decline: "declined the team offer.",
		};
		await context.thread.send({
			content: `<@${interaction.user.id}> ${messages[action]}`,
			allowedMentions: { parse: [], users: [interaction.user.id] },
		});
		await interaction.editReply(`Team Finder ${messages[action]}`);
		if (action !== "offer") await context.thread.edit({ locked: true, archived: true });
	});
}

async function close(interaction: ChatInputCommandInteraction, forum: ForumChannel, botId: string) {
	await withTeamFinderKey(listingOperationKey(interaction.user.id), async () => {
		const webhook = await managedListingWebhook(forum, botId);
		const thread = await findListingThread(forum, interaction.user.id, webhook.id);
		if (!thread) throw new UserError("You do not have an open Team Finder listing. | Vous n’avez aucune annonce Team Finder ouverte.");
		await closeListingThread(thread);
		await interaction.editReply("Team Finder closed your public listing. | Team Finder a fermé votre annonce publique.");
	});
}

export default function registerTeamFinder(client: Client) {
	const config = loadTeamFinderConfig();
	if (!config) return void console.warn("Team Finder disabled: required channel configuration is missing or invalid");
	const api = new TeamFinderApi(config.TRACK_THE_HACK_URL, config.INTERNAL_API_SECRET);
	client.on("interactionCreate", async raw => {
		if (!raw.isChatInputCommand() || raw.commandName !== "team-find") return;
		try {
			await raw.deferReply({ ephemeral: true });
			const { forum, conversations, member } = await checkedContext(raw, config);
			const subcommand = raw.options.getSubcommand();
			if (subcommand === "post") await post(raw, forum, conversations, member, client.user!.id);
			else if (subcommand === "dm") await dm(raw, forum, conversations, client.user!.id, config, api);
			else if (subcommand === "close") await close(raw, forum, client.user!.id);
			else if (subcommand === "rankings") await rankings(raw, api);
			else if (["rank", "offer", "accept", "reject", "decline"].includes(subcommand)) {
				await requestAction(
					raw, forum, conversations, client.user!.id, api,
					subcommand as "rank" | "offer" | "accept" | "reject" | "decline",
				);
			}
		} catch (error) {
			if (!(error instanceof UserError) && !(error instanceof TeamFinderApiError)) {
				console.error("Team Finder interaction failed", { name: error instanceof Error ? error.name : "UnknownError" });
			}
			const content = error instanceof UserError || error instanceof TeamFinderApiError
				? `Team Finder: ${error.message}` : GENERIC_ERROR;
			if (raw.replied || raw.deferred) await raw.editReply(content).catch(() => undefined);
			else await raw.reply({ content, ephemeral: true }).catch(() => undefined);
		}
	});
	client.on("messageUpdate", async (_oldMessage, rawMessage) => {
		let message: Message | undefined;
		try {
			message = rawMessage.partial ? await rawMessage.fetch() : rawMessage;
			if (message.guildId !== config.COMMUNITY_GUILD_ID || message.author.bot || message.webhookId) return;
			const forum = await message.guild!.channels.fetch(config.TEAM_FINDER_FORUM_CHANNEL_ID);
			if (!forum || forum.type !== ChannelType.GuildForum) return;
			const webhook = await managedListingWebhook(forum, client.user!.id);
			await withTeamFinderKey(listingOperationKey(message.author.id), () =>
				syncQuestionnaireEdit(message!, forum, webhook, client.user!.id));
		} catch (error) {
			if (!(error instanceof UserError)) console.error("Team Finder listing edit failed", error);
			if (message) await message.reply({
				content: `Team Finder did not update the public listing. ${error instanceof UserError ? error.message : "Try again."}`,
				allowedMentions: { repliedUser: false },
			}).catch(() => undefined);
		}
	});
	console.log("Team Finder enabled");
}
