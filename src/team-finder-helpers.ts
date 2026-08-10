const SNOWFLAKE = /^[1-9]\d{16,19}$/;
const MARKER = /(?:^|\n)Posted by \/ Publié par <@([1-9]\d{16,19})>(?: · \[Edit answers \/ Modifier les réponses\]\(https:\/\/discord\.com\/channels\/[1-9]\d{16,19}\/[1-9]\d{16,19}\))?$/;
const CONVERSATION_MARKER = /--tf1-([1-9]\d{16,19})-([1-9]\d{16,19})-([1-9]\d{16,19})$/;
const FINAL_TEAM_MARKER = /--tf-final-([1-9]\d{16,19})$/;
const keyedTurns = new Map<string, Promise<void>>();

export type ListingMetadata = { version: 1; ownerId: string };
export type ListingReference = { threadId: string; guildId?: string };
export type ConversationMetadata = { version: 1; listingId: string; userIds: [string, string] };
export type QuestionnaireAnswers = { title: string; pitch: string; teammates: string; skills: string };
export type QuestionnaireReceipt = { listingId: string; guildId: string; channelId: string; answers: QuestionnaireAnswers };

export function listingMarker(ownerId: string) {
	if (!SNOWFLAKE.test(ownerId)) throw new Error("Invalid listing owner ID");
	return `Posted by / Publié par <@${ownerId}>`;
}

export function parseListingMetadata(value?: string | null): ListingMetadata | null {
	const match = value?.match(MARKER);
	return match ? { version: 1, ownerId: match[1] } : null;
}

function parseMessageUrl(value: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.hostname !== "discord.com" || url.search || url.hash) return null;
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length !== 4 || parts[0] !== "channels" || !parts.slice(1).every(id => SNOWFLAKE.test(id))) return null;
	return { guildId: parts[1]!, channelId: parts[2]!, messageId: parts[3]! };
}

export function questionnaireReceipt(listingUrl: string, answers: QuestionnaireAnswers) {
	return [
		`Team Finder published your listing: ${listingUrl}`,
		"Edit a saved answer to update the public post.",
		`Title: ${answers.title}`,
		`Pitch: ${answers.pitch}`,
		`Teammates: ${answers.teammates}`,
		`Skills: ${answers.skills}`,
	].join("\n");
}

export function parseQuestionnaireReceipt(content: string): QuestionnaireReceipt | null {
	const lines = content.split("\n");
	if (lines.length !== 6 || lines[1] !== "Edit a saved answer to update the public post.") return null;
	const listing = parseListingReference(lines[0]?.replace("Team Finder published your listing: ", "") ?? "");
	const entries = Object.fromEntries([
		["title", "Title: "], ["pitch", "Pitch: "], ["teammates", "Teammates: "], ["skills", "Skills: "],
	].map(([key, prefix], index) => [key, parseMessageUrl(lines[index + 2]?.replace(prefix, "") ?? "")]));
	const references = Object.values(entries);
	if (!listing?.guildId || references.some(reference => !reference)) return null;
	if (references.some(reference => reference!.guildId !== listing.guildId || reference!.channelId !== references[0]!.channelId)) return null;
	return {
		listingId: listing.threadId, guildId: listing.guildId, channelId: references[0]!.channelId,
		answers: Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, value!.messageId])) as QuestionnaireAnswers,
	};
}

export function parseListingReference(value: string): ListingReference | null {
	const input = value.trim();
	if (SNOWFLAKE.test(input)) return { threadId: input };
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.hostname !== "discord.com" || url.search || url.hash) return null;
	const parts = url.pathname.split("/").filter(Boolean);
	if ((parts.length !== 3 && parts.length !== 4) || parts[0] !== "channels") return null;
	const [guildId, threadId, messageId] = parts.slice(1);
	if (![guildId, threadId, messageId].filter(Boolean).every(id => SNOWFLAKE.test(id!))) return null;
	return { guildId, threadId };
}

function conversationIds(listingId: string, firstUserId: string, secondUserId: string) {
	if (![listingId, firstUserId, secondUserId].every(id => SNOWFLAKE.test(id))) throw new Error("Invalid conversation ID");
	return { listingId, users: [firstUserId, secondUserId].sort() };
}

export function conversationKey(listingId: string, firstUserId: string, secondUserId: string) {
	const { users } = conversationIds(listingId, firstUserId, secondUserId);
	return `team-find-${listingId.slice(-6)}-${users[0].slice(-4)}-${users[1].slice(-4)}`;
}

export function conversationThreadName(listingId: string, firstUserId: string, secondUserId: string) {
	const { users } = conversationIds(listingId, firstUserId, secondUserId);
	return `${conversationKey(listingId, users[0], users[1])}--tf1-${listingId}-${users[0]}-${users[1]}`;
}

export function conversationMetadataMatches(name: string, listingId: string, firstUserId: string, secondUserId: string) {
	const metadata = parseConversationMetadata(name);
	if (!metadata) return false;
	const expected = conversationIds(listingId, firstUserId, secondUserId);
	return metadata.listingId === expected.listingId && metadata.userIds.join(":") === expected.users.join(":");
}

export function parseConversationMetadata(name: string): ConversationMetadata | null {
	const match = CONVERSATION_MARKER.exec(name);
	return match ? { version: 1, listingId: match[1], userIds: [match[2], match[3]].sort() as [string, string] } : null;
}

export function finalTeamThreadName(teamName: string) {
	const cleanName = teamName.trim().replace(/[\r\n]+/g, " ") || "Team";
	return cleanName.slice(0, 100);
}

export function finalTeamMetadataMatches(name: string, conversationId: string) {
	return SNOWFLAKE.test(conversationId) && FINAL_TEAM_MARKER.exec(name)?.[1] === conversationId;
}

export function finalTeamNameMatches(name: string, teamName: string) {
	const expected = finalTeamThreadName(teamName);
	if (name === expected) return true;
	const legacy = FINAL_TEAM_MARKER.exec(name);
	return Boolean(legacy && name.slice(0, legacy.index) === expected.slice(0, legacy.index));
}

export async function findArchivedThread<T extends { archivedAt: Date | null }>(
	fetchPage: (before?: Date) => Promise<{ threads: { values(): IterableIterator<T> }; hasMore: boolean }>,
	matches: (thread: T) => boolean | Promise<boolean>,
) {
	let before: Date | undefined;
	for (;;) {
		const page = await fetchPage(before);
		const threads = [...page.threads.values()];
		for (const thread of threads) if (await matches(thread)) return thread;
		if (!page.hasMore) return null;
		const timestamps = threads.flatMap(thread => thread.archivedAt ? [thread.archivedAt.getTime()] : []);
		if (!timestamps.length) throw new Error("Archived thread pagination has no cursor");
		const next = new Date(Math.min(...timestamps));
		if (before && next.getTime() >= before.getTime()) throw new Error("Archived thread pagination did not advance");
		before = next;
	}
}

export async function withTeamFinderKey<T>(key: string, operation: () => Promise<T>) {
	const previous = keyedTurns.get(key) ?? Promise.resolve();
	let release!: () => void;
	const turn = new Promise<void>(resolve => { release = resolve; });
	const tail = previous.catch(() => undefined).then(() => turn);
	keyedTurns.set(key, tail);
	await previous.catch(() => undefined);
	try {
		return await operation();
	} finally {
		release();
		if (keyedTurns.get(key) === tail) keyedTurns.delete(key);
	}
}

export function listingOperationKey(ownerId: string) {
	return `listing:${ownerId}`;
}

export function dmDecision(ownerId: string, requesterId: string) {
	return ownerId === requesterId ? "self" as const : "allowed" as const;
}
