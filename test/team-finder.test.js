import assert from "node:assert/strict";
import test from "node:test";
import { ChannelFlags, ChannelType, PermissionFlagsBits } from "discord.js";
import { loadTeamFinderConfig } from "../dist/config.js";
import { teamFinderRegistration } from "../dist/team-finder-command.js";
import {
	conversationKey,
	conversationMetadataMatches,
	conversationThreadName,
	dmDecision,
	finalTeamMetadataMatches,
	finalTeamNameMatches,
	finalTeamThreadName,
	listingMarker,
	listingOperationKey,
	parseConversationMetadata,
	parseListingMetadata,
	parseListingReference,
	parseQuestionnaireReceipt,
	questionnaireReceipt,
	withTeamFinderKey,
} from "../dist/team-finder-helpers.js";
import {
	authenticatedListingOwner,
	authenticConversationThread,
	authenticFinalTeamThread,
	closeListingThread,
	collectListingDraft,
	decrementedListingContent,
	findListingThread,
	findOrCreatePrivateConversation,
	listingContent,
	managedListingWebhook,
	parseListingAnswer,
	preparePrivateConversation,
	TEAM_FINDER_CONVERSATION_PERMISSIONS,
	TEAM_FINDER_FORUM_PERMISSIONS,
	upsertListingThread,
	updateListingThread,
} from "../dist/team-finder.js";
import { formatRankings, TeamFinderApi } from "../dist/team-finder-api.js";
import { verificationLink } from "../dist/verification-link.js";
import { createHmac } from "node:crypto";

const ids = {
	guild: "123456789012345678",
	role: "223456789012345678",
	forum: "323456789012345678",
	conversations: "423456789012345678",
	listing: "523456789012345678",
	owner: "623456789012345678",
	requester: "723456789012345678",
	message: "823456789012345678",
	bot: "923456789012345678",
	extra: "103456789012345678",
	webhook: "113456789012345678",
};

const enabledEnv = {
	COMMUNITY_GUILD_ID: ids.guild,
	COMMUNITY_GUILD_HACKER_ROLE_ID: ids.role,
	TEAM_FINDER_FORUM_CHANNEL_ID: ids.forum,
	TEAM_FINDER_CONVERSATION_CHANNEL_ID: ids.conversations,
	TRACK_THE_HACK_URL: "http://localhost:3000",
	INTERNAL_API_SECRET: "a".repeat(32),
};

test("listing metadata is versioned and rejects malformed or future markers", () => {
	const marker = listingMarker(ids.owner);
	assert.equal(marker, `Posted by / Publié par <@${ids.owner}>`);
	assert.deepEqual(parseListingMetadata(marker), { version: 1, ownerId: ids.owner });
	assert.deepEqual(parseListingMetadata(`**Rich text**\n\n${marker}`), { version: 1, ownerId: ids.owner });
	assert.equal(parseListingMetadata(`Posted by / Publié par <@${ids.owner}> extra`), null);
	assert.equal(parseListingMetadata(), null);
	assert.throws(() => listingMarker("not-an-id"));
});

test("questionnaire receipts preserve the listing and answer message IDs", () => {
	const answers = {
		title: `https://discord.com/channels/${ids.guild}/${ids.conversations}/${ids.message}`,
		pitch: `https://discord.com/channels/${ids.guild}/${ids.conversations}/${ids.owner}`,
		teammates: `https://discord.com/channels/${ids.guild}/${ids.conversations}/${ids.requester}`,
		skills: `https://discord.com/channels/${ids.guild}/${ids.conversations}/${ids.extra}`,
	};
	const content = questionnaireReceipt(`https://discord.com/channels/${ids.guild}/${ids.listing}`, answers);
	assert.deepEqual(parseQuestionnaireReceipt(content), {
		listingId: ids.listing, guildId: ids.guild, channelId: ids.conversations,
		answers: { title: ids.message, pitch: ids.owner, teammates: ids.requester, skills: ids.extra },
	});
	assert.equal(parseQuestionnaireReceipt(content.replace("Title:", "Name:")), null);
});

test("listing references accept strict IDs and Discord thread URLs only", () => {
	assert.deepEqual(parseListingReference(ids.listing), { threadId: ids.listing });
	assert.deepEqual(
		parseListingReference(`https://discord.com/channels/${ids.guild}/${ids.listing}`),
		{ guildId: ids.guild, threadId: ids.listing },
	);
	assert.deepEqual(
		parseListingReference(`https://discord.com/channels/${ids.guild}/${ids.listing}/${ids.message}`),
		{ guildId: ids.guild, threadId: ids.listing },
	);
	assert.equal(parseListingReference(`http://discord.com/channels/${ids.guild}/${ids.listing}`), null);
	assert.equal(parseListingReference(`https://discord.com.evil.test/channels/${ids.guild}/${ids.listing}`), null);
	assert.equal(parseListingReference(`https://discord.com/channels/${ids.guild}/${ids.listing}?x=1`), null);
	assert.equal(parseListingReference(`${ids.listing}/extra`), null);
});

test("conversation names are bounded and independent of user order", () => {
	const forward = conversationThreadName(ids.listing, ids.owner, ids.requester);
	const reverse = conversationThreadName(ids.listing, ids.requester, ids.owner);
	assert.equal(forward, reverse);
	assert.equal(forward, `${conversationKey(ids.listing, ids.owner, ids.requester)}--tf1-${ids.listing}-${ids.owner}-${ids.requester}`);
	assert.equal(conversationMetadataMatches(forward, ids.listing, ids.requester, ids.owner), true);
	assert.deepEqual(parseConversationMetadata(forward), {
		version: 1, listingId: ids.listing, userIds: [ids.owner, ids.requester].sort(),
	});
	assert.equal(conversationMetadataMatches(forward.replace("--tf1-", "--tf2-"), ids.listing, ids.owner, ids.requester), false);
	assert.ok(forward.length <= 100);
	assert.throws(() => conversationThreadName(ids.listing, ids.owner, "invalid"));
});

test("final team names stay clean and recognize the old hidden marker", () => {
	const name = finalTeamThreadName("Accessible Transit Builders");
	const legacy = `${name}--tf-final-${ids.message}`;
	assert.equal(name, "Accessible Transit Builders");
	assert.equal(finalTeamNameMatches(name, name), true);
	assert.equal(finalTeamNameMatches(legacy, name), true);
	assert.equal(finalTeamMetadataMatches(legacy, ids.message), true);
	assert.equal(finalTeamMetadataMatches(legacy, ids.listing), false);
	assert.ok(finalTeamThreadName("x".repeat(200)).length <= 100);
});

test("final team authentication binds the bot, parent channel, guild, and conversation", () => {
	const channel = { id: ids.conversations, guildId: ids.guild };
	const thread = {
		type: ChannelType.PrivateThread, parentId: ids.conversations, guildId: ids.guild,
		ownerId: ids.bot, name: finalTeamThreadName("Accessible Transit Builders"),
	};
	assert.equal(authenticFinalTeamThread(thread, channel, "Accessible Transit Builders", ids.bot), true);
	assert.equal(authenticFinalTeamThread({ ...thread, ownerId: ids.extra }, channel, "Accessible Transit Builders", ids.bot), false);
	assert.equal(authenticFinalTeamThread({ ...thread, parentId: ids.forum }, channel, "Accessible Transit Builders", ids.bot), false);
	assert.equal(authenticFinalTeamThread(thread, channel, "Another Team", ids.bot), false);
});

test("self-DM is rejected as a pure decision", () => {
	assert.equal(dmDecision(ids.owner, ids.owner), "self");
	assert.equal(dmDecision(ids.owner, ids.requester), "allowed");
});

test("Team Finder config fails closed unless every ID is present and valid", () => {
	assert.deepEqual(loadTeamFinderConfig(enabledEnv), enabledEnv);
	assert.equal(loadTeamFinderConfig({ ...enabledEnv, TEAM_FINDER_FORUM_CHANNEL_ID: undefined }), null);
	assert.equal(loadTeamFinderConfig({ ...enabledEnv, TEAM_FINDER_CONVERSATION_CHANNEL_ID: "not-an-id" }), null);
});

test("registration is disabled without config and community-guild-only when enabled", () => {
	assert.deepEqual(teamFinderRegistration(null), { community: [], organizer: [], shared: [] });
	const registration = teamFinderRegistration(loadTeamFinderConfig(enabledEnv));
	assert.equal(registration.community.length, 1);
	assert.deepEqual(registration.organizer, []);
	assert.deepEqual(registration.shared, []);
	const command = registration.community[0];
	assert.equal(command.name, "team-find");
	assert.deepEqual(command.options?.map(option => option.name), [
		"post", "dm", "close", "rank", "rankings", "offer", "accept", "reject", "decline",
	]);
	const post = command.options?.find(option => option.name === "post");
	assert.deepEqual(post?.options, []);
	const dm = command.options?.find(option => option.name === "dm");
	assert.equal(dm?.options?.[0]?.description, "Paste the Discord link for the listing | Collez le lien Discord de l’annonce");
	const rank = command.options?.find(option => option.name === "rank");
	assert.equal(rank?.options?.[0]?.name, "position");
	assert.equal(rank?.options?.[0]?.min_value, 1);
	const accept = command.options?.find(option => option.name === "accept");
	assert.equal(accept?.options?.[0]?.name, "team_name");
});

test("the API client signs the exact request body with a unique request ID", async () => {
	let captured;
	const api = new TeamFinderApi("https://track.example/base", "s".repeat(32), async (url, init) => {
		captured = { url, init };
		return new Response(JSON.stringify({ hacker: { id: "h1", name: "Ada", discordId: ids.owner }, team: null }), {
			status: 200, headers: { "content-type": "application/json" },
		});
	});
	const result = await api.resolve(ids.owner);
	assert.equal(result.hacker.discordId, ids.owner);
	assert.equal(captured.url, "https://track.example/base/api/internal/team-operations");
	assert.deepEqual(JSON.parse(captured.init.body), { action: "resolve", actorDiscordId: ids.owner });
	const timestamp = captured.init.headers["x-track-the-hack-timestamp"];
	const requestId = captured.init.headers["x-track-the-hack-request-id"];
	assert.match(requestId, /^[0-9a-f-]{36}$/);
	assert.equal(
		captured.init.headers["x-track-the-hack-signature"],
		createHmac("sha256", "s".repeat(32)).update(`${timestamp}.${requestId}.${captured.init.body}`).digest("hex"),
	);
});

test("private ranking output shows both ordered party views", () => {
	const output = formatRankings(
		[{ id: "a", conversationDiscordThreadId: ids.message, label: "Team Ada", rank: 1, status: "OFFERED" }],
		[{ id: "b", conversationDiscordThreadId: ids.listing, label: "Grace Hopper", rank: 2, status: "INTERESTED" }],
	);
	assert.match(output, /Your requester choices[\s\S]*1\. Team Ada — OFFERED/);
	assert.match(output, /Your owner choices[\s\S]*2\. Grace Hopper — INTERESTED/);
});

test("verification links include the Track the Hack ID, timestamp, and signature proof", () => {
	const link = new URL(verificationLink("https://track.example/", "v".repeat(32), ids.owner, 1_767_225_600_000));
	assert.equal(link.pathname, "/discord");
	assert.equal(link.searchParams.get("id"), ids.owner);
	assert.equal(link.searchParams.get("timestamp"), "1767225600");
	assert.equal(
		link.searchParams.get("signature"),
		createHmac("sha256", "v".repeat(32)).update(`verify:1767225600:${ids.owner}`).digest("hex"),
	);
});

test("questionnaire answers preserve multiline text and enforce control keywords and bounds", () => {
	for (const step of ["title", "pitch", "teammates", "skills", "confirm"]) {
		assert.deepEqual(parseListingAnswer(step, " CANCEL "), { action: "cancel" });
	}
	assert.deepEqual(parseListingAnswer("title", "Accessible travel planner"), { action: "accept", value: "Accessible travel planner" });
	assert.deepEqual(parseListingAnswer("title", "line one\nline two"), { action: "retry" });
	assert.deepEqual(parseListingAnswer("title", "x".repeat(101)), { action: "retry" });
	assert.deepEqual(parseListingAnswer("pitch", " First line\nSecond line "), { action: "accept", value: "First line\nSecond line" });
	assert.deepEqual(parseListingAnswer("pitch", "x".repeat(4_097)), { action: "retry" });
	assert.deepEqual(parseListingAnswer("teammates", "2"), { action: "accept", value: 2 });
	assert.deepEqual(parseListingAnswer("teammates", "4"), { action: "retry" });
	assert.deepEqual(parseListingAnswer("skills", "SKIP"), { action: "accept", value: "" });
	assert.deepEqual(parseListingAnswer("confirm", "publish"), { action: "publish" });
});

test("guided questionnaire retries in sequence, previews, and publishes a complete draft", async () => {
	const answers = ["bad\ntitle", "Clean public title", "Pitch line one\nPitch line two", "4", "2", "skip", "later", "publish"];
	const sent = [];
	let messageIndex = 0;
	const thread = {
		async send(message) { sent.push(message); },
		async awaitMessages(options) {
			const id = String(900000000000000000n + BigInt(messageIndex++));
			const message = {
				id, url: `https://discord.com/channels/${ids.guild}/${ids.conversations}/${id}`,
				author: { id: ids.owner }, content: answers.shift(),
			};
			assert.equal(options.filter(message), true);
			assert.equal(options.filter({ ...message, author: { id: ids.extra } }), false);
			return { first: () => message };
		},
	};
	const draft = await collectListingDraft(thread, ids.owner);
	assert.equal(draft.status, "publish");
	assert.equal(draft.title, "Clean public title");
	assert.equal(draft.pitch, "Pitch line one\nPitch line two");
	assert.equal(draft.teammates, 2);
	assert.equal(draft.skills, "");
	assert.deepEqual(Object.keys(draft.answers), ["title", "pitch", "teammates", "skills"]);
	assert.equal(answers.length, 0);
	assert.equal(sent.some(message => typeof message === "string" && message.includes("1 to 100")), true);
	assert.equal(sent.some(message => typeof message === "string" && message.includes("`1`, `2`, or `3`")), true);
	const preview = sent.find(message => typeof message === "object");
	assert.match(preview.content, /Clean public title/);
	assert.match(preview.content, /Pitch line one\nPitch line two/);
	assert.equal(preview.embeds, undefined);
});

test("guided questionnaire times out without publishing", async () => {
	const sent = [];
	const thread = {
		async send(message) { sent.push(message); },
		async awaitMessages() { return { first: () => undefined }; },
	};
	assert.deepEqual(await collectListingDraft(thread, ids.owner), { status: "timeout" });
	assert.equal(sent.length, 1);
});

function mockListing(overrides = {}) {
	const events = [];
	const starter = {
		id: ids.message,
		author: { id: overrides.authorId ?? ids.webhook },
		webhookId: overrides.webhookId ?? ids.webhook,
		content: overrides.content ?? listingMarker(overrides.ownerId ?? ids.owner),
	};
	const thread = {
		id: overrides.id ?? ids.listing,
		type: ChannelType.PublicThread,
		parentId: overrides.parentId ?? ids.forum,
		guildId: overrides.guildId ?? ids.guild,
		archived: overrides.archived ?? true,
		locked: overrides.locked ?? false,
		archivedAt: overrides.archivedAt ?? new Date("2026-08-01T00:00:00Z"),
		async fetchStarterMessage() {
			if (overrides.starterError) throw overrides.starterError;
			return overrides.starterNull ? null : starter;
		},
		async setArchived(value) { events.push(`archive:${value}`); thread.archived = value; },
		async setName(value) { events.push(`name:${value}`); thread.name = value; },
		async edit(value) { events.push({ editThread: value }); Object.assign(thread, value); },
	};
	return { thread, events };
}

test("listing authentication requires the bot marker and exact forum guild", async () => {
	const { thread } = mockListing();
	assert.equal(await authenticatedListingOwner(thread, ids.webhook, ids.forum, ids.guild), ids.owner);
	assert.equal(await authenticatedListingOwner({ ...thread, parentId: ids.conversations }, ids.webhook, ids.forum, ids.guild), null);
	assert.equal(await authenticatedListingOwner({ ...thread, guildId: ids.requester }, ids.webhook, ids.forum, ids.guild), null);
	assert.equal(await authenticatedListingOwner(thread, ids.requester, ids.forum, ids.guild), null);
	assert.equal(await authenticatedListingOwner(mockListing({ authorId: ids.bot }).thread, ids.webhook, ids.forum, ids.guild), null);
	assert.equal(await authenticatedListingOwner(mockListing({ webhookId: ids.bot }).thread, ids.webhook, ids.forum, ids.guild), null);
	const malformed = mockListing({ content: `Posted by / Publié par <@${ids.owner}> extra` }).thread;
	assert.equal(await authenticatedListingOwner(malformed, ids.webhook, ids.forum, ids.guild), null);
});

test("listing scans skip deleted starters but still propagate non-deletion failures", async () => {
	const deleted = mockListing({ id: "133456789012345678", starterError: Object.assign(new Error("Unknown Message"), { code: 10008 }) }).thread;
	const valid = mockListing({ id: "143456789012345678" }).thread;
	const forum = {
		id: ids.forum, guildId: ids.guild,
		threads: {
			async fetchActive() { return { threads: new Map([[deleted.id, deleted], [valid.id, valid]]) }; },
			async fetchArchived() { throw new Error("active listing should be found"); },
		},
	};
	assert.equal(await findListingThread(forum, ids.owner, ids.webhook), valid);
	const failed = mockListing({ starterError: new Error("network failure") }).thread;
	forum.threads.fetchActive = async () => ({ threads: new Map([[failed.id, failed]]) });
	await assert.rejects(() => findListingThread(forum, ids.owner, ids.webhook), /network failure/);
});

test("archived listings paginate, remain usable while unlocked, update, and close atomically", async () => {
	const decoy = mockListing({ ownerId: ids.requester, archivedAt: new Date("2026-08-02T00:00:00Z") }).thread;
	const target = mockListing({ archivedAt: new Date("2026-08-01T00:00:00Z") });
	const archivedOptions = [];
	const forum = {
		id: ids.forum, guildId: ids.guild,
		threads: {
			async fetchActive() { return { threads: new Map() }; },
			async fetchArchived(options) {
				archivedOptions.push(options);
				return archivedOptions.length === 1
					? { threads: new Map([[decoy.id, decoy]]), hasMore: true }
					: { threads: new Map([[target.thread.id, target.thread]]), hasMore: false };
			},
		},
	};
	assert.equal(await findListingThread(forum, ids.owner, ids.webhook), target.thread);
	assert.equal(archivedOptions[0].type, "public");
	assert.equal(archivedOptions[0].limit, 100);
	assert.equal(archivedOptions[1].before.toISOString(), decoy.archivedAt.toISOString());
	const webhook = { async editMessage(id, options) { target.events.push({ editMessage: id, options }); } };
	await updateListingThread(target.thread, webhook, "Clean listing title", "Updated rich text");
	assert.equal(target.events[0], "archive:false");
	assert.equal(target.events[1].editMessage, ids.message);
	assert.equal(target.events[1].options.threadId, target.thread.id);
	assert.equal(target.events[2], "name:Clean listing title");
	await closeListingThread(target.thread);
	assert.deepEqual(target.events.at(-1), { editThread: { locked: true, archived: true } });

	const closed = mockListing({ locked: true }).thread;
	forum.threads.fetchArchived = async () => ({ threads: new Map([[closed.id, closed]]), hasMore: false });
	assert.equal(await findListingThread(forum, ids.owner, ids.webhook), null);
});

test("managed listing webhook is bot-owned, named, and unique", async () => {
	const expected = {
		id: ids.webhook, channelId: ids.forum, name: "Team Finder Listings", token: "test-token",
		owner: { id: ids.bot }, isIncoming: () => true,
	};
	let createdWith;
	const forum = {
		id: ids.forum,
		async fetchWebhooks() { return new Map([[ids.webhook, expected]]); },
		async createWebhook(options) { createdWith = options; return expected; },
	};
	assert.equal(await managedListingWebhook(forum, ids.bot), expected);
	assert.equal(createdWith, undefined);
	forum.fetchWebhooks = async () => new Map();
	assert.equal(await managedListingWebhook(forum, ids.bot), expected);
	assert.equal(createdWith.name, "Team Finder Listings");
	forum.fetchWebhooks = async () => new Map([["a", expected], ["b", { ...expected, id: ids.extra }]]);
	await assert.rejects(() => managedListingWebhook(forum, ids.bot), /duplicate Team Finder webhooks/i);
});

test("listing creation uses a clean webhook title and hacker display identity", async () => {
	let requireTag = true;
	let sentWith;
	const createdThread = {
		id: ids.listing, type: ChannelType.PublicThread, parentId: ids.forum,
		url: `https://discord.com/channels/${ids.guild}/${ids.listing}`, isThread: () => true,
	};
	const webhook = {
		id: ids.webhook, channelId: ids.forum, name: "Team Finder Listings", token: "test-token",
		owner: { id: ids.bot }, isIncoming: () => true,
		async send(options) { sentWith = options; return { channelId: ids.listing }; },
	};
	const owner = {
		id: ids.owner, displayName: "Ada Lovelace", displayAvatarURL: () => "https://cdn.discordapp.com/avatar.png",
	};
	const forum = {
		id: ids.forum, guildId: ids.guild,
		flags: { has(flag) { assert.equal(flag, ChannelFlags.RequireTag); return requireTag; } },
		async fetchWebhooks() { return new Map([[ids.webhook, webhook]]); },
		async createWebhook() { throw new Error("must reuse managed webhook"); },
		guild: { channels: { async fetch(id) { assert.equal(id, ids.listing); return createdThread; } } },
		threads: {
			async fetchActive() { return { threads: new Map() }; },
			async fetchArchived() { return { threads: new Map(), hasMore: false }; },
		},
	};
	await assert.rejects(
		() => upsertListingThread(forum, owner, ids.bot, "Accessible travel planner", "Build accessibility tools", 2, "TypeScript"),
		/requires a tag.*no configured tag/i,
	);
	assert.equal(sentWith, undefined);
	requireTag = false;
	const result = await upsertListingThread(forum, owner, ids.bot, "Accessible travel planner", "Build accessibility tools", 2, "TypeScript");
	assert.deepEqual(result, { thread: createdThread, updated: false });
	assert.equal(sentWith.threadName, "Accessible travel planner");
	assert.equal(sentWith.username, "Ada Lovelace");
	assert.equal(sentWith.avatarURL, "https://cdn.discordapp.com/avatar.png");
	assert.match(sentWith.content, /^\*\*Teammates wanted \/ Coéquipiers recherchés: 2\*\*/);
	assert.match(sentWith.content, /Build accessibility tools/);
	assert.match(sentWith.content, /\*\*Skills or interests \/ Compétences ou intérêts\*\*\nTypeScript/);
	assert.match(sentWith.content, new RegExp(`${ids.owner}>$`));
	assert.equal(sentWith.embeds, undefined);
});

test("accepted members decrement listing slots without changing rich text", () => {
	const source = listingContent(ids.owner, "A **bold** pitch\nwith a link: https://example.com", 3, "TypeScript");
	const result = decrementedListingContent(source, 2);
	assert.equal(result.remaining, 1);
	assert.match(result.content, /^\*\*Teammates wanted \/ Coéquipiers recherchés: 1\*\*/);
	assert.match(result.content, /A \*\*bold\*\* pitch\nwith a link: https:\/\/example.com/);
	assert.throws(
		() => decrementedListingContent("No slot header", 1),
		/invalid slot count/,
	);
});

function privateCandidate(overrides = {}) {
	return {
		id: overrides.id ?? "113456789012345678",
		name: overrides.name ?? conversationThreadName(ids.listing, ids.owner, ids.requester),
		type: ChannelType.PrivateThread,
		parentId: overrides.parentId ?? ids.conversations,
		guildId: overrides.guildId ?? ids.guild,
		ownerId: overrides.ownerId ?? ids.bot,
		archivedAt: overrides.archivedAt ?? new Date("2026-08-01T00:00:00Z"),
	};
}

test("private conversation authentication binds bot, parent, guild, listing, and unordered pair", () => {
	const channel = { id: ids.conversations, guildId: ids.guild };
	const thread = privateCandidate();
	assert.equal(authenticConversationThread(thread, channel, ids.listing, ids.requester, ids.owner, ids.bot), true);
	assert.equal(authenticConversationThread({ ...thread, ownerId: ids.extra }, channel, ids.listing, ids.owner, ids.requester, ids.bot), false);
	assert.equal(authenticConversationThread({ ...thread, parentId: ids.forum }, channel, ids.listing, ids.owner, ids.requester, ids.bot), false);
	assert.equal(authenticConversationThread({ ...thread, guildId: ids.extra }, channel, ids.listing, ids.owner, ids.requester, ids.bot), false);
	assert.equal(authenticConversationThread({ ...thread, name: conversationKey(ids.listing, ids.owner, ids.requester) }, channel, ids.listing, ids.owner, ids.requester, ids.bot), false);
	assert.equal(authenticConversationThread(thread, channel, ids.message, ids.owner, ids.requester, ids.bot), false);
});

test("same-key private thread collisions with missing or mismatched metadata are rejected", async () => {
	const key = conversationKey(ids.listing, ids.owner, ids.requester);
	let created = false;
	const channel = {
		id: ids.conversations, guildId: ids.guild,
		threads: {
			async fetchActive() { return { threads: new Map([["missing", privateCandidate({ name: key })]]) }; },
			async fetchArchived() { throw new Error("must not inspect archives after collision"); },
			async create() { created = true; },
		},
	};
	await assert.rejects(() => findOrCreatePrivateConversation(channel, ids.listing, ids.owner, ids.requester, ids.bot), /conflicting private thread/i);
	assert.equal(created, false);
	channel.threads.fetchActive = async () => ({ threads: new Map([["wrong", privateCandidate({ name: `${key}--tf2-${ids.listing}-${ids.owner}-${ids.requester}` })]]) });
	await assert.rejects(() => findOrCreatePrivateConversation(channel, ids.listing, ids.owner, ids.requester, ids.bot), /conflicting private thread/i);
});

test("archived private lookup follows hasMore with the archive timestamp cursor", async () => {
	const first = privateCandidate({ id: "123456789012345679", name: "unrelated", archivedAt: new Date("2026-08-03T00:00:00Z") });
	const expected = privateCandidate({ archivedAt: new Date("2026-08-02T00:00:00Z") });
	const options = [];
	const channel = {
		id: ids.conversations, guildId: ids.guild,
		threads: {
			async fetchActive() { return { threads: new Map() }; },
			async fetchArchived(value) {
				options.push(value);
				return options.length === 1
					? { threads: new Map([[first.id, first]]), hasMore: true }
					: { threads: new Map([[expected.id, expected]]), hasMore: false };
			},
			async create() { throw new Error("must reuse archived thread"); },
		},
	};
	const result = await findOrCreatePrivateConversation(channel, ids.listing, ids.owner, ids.requester, ids.bot);
	assert.equal(result.thread, expected);
	assert.equal(result.created, false);
	assert.equal(options[0].type, "private");
	assert.equal(options[0].fetchAll, true);
	assert.equal(options[0].limit, 100);
	assert.equal(options[1].before.toISOString(), first.archivedAt.toISOString());
});

function privatePreparationThread({ failRemoval } = {}) {
	const events = [];
	const thread = {
		archived: true, locked: true,
		members: {
			async fetch() { events.push("fetch"); return new Map([[ids.bot, {}], [ids.owner, {}], [ids.extra, {}], [ids.message, {}]]); },
			async remove(id) { events.push(`remove:${id}`); if (id === failRemoval) throw new Error("cleanup failed"); },
			async add(id) { events.push(`add:${id}`); },
		},
		async setArchived(value) { events.push(`archive:${value}`); thread.archived = value; },
		async setLocked(value) { events.push(`lock:${value}`); thread.locked = value; },
		async setInvitable(value) { events.push(`invitable:${value}`); },
	};
	return { thread, events };
}

test("private reuse unarchives before removing members and adds participants only after cleanup", async () => {
	const { thread, events } = privatePreparationThread();
	await preparePrivateConversation(thread, ids.owner, ids.requester, ids.bot);
	assert.deepEqual(events, [
		"fetch", "archive:false", `remove:${ids.extra}`, `remove:${ids.message}`,
		"lock:false", "invitable:false", `add:${ids.owner}`, `add:${ids.requester}`,
	]);
});

test("partial membership cleanup failure aborts before history exposure or participant adds", async () => {
	const { thread, events } = privatePreparationThread({ failRemoval: ids.message });
	await assert.rejects(() => preparePrivateConversation(thread, ids.owner, ids.requester, ids.bot), /cleanup failed/);
	assert.deepEqual(events, ["fetch", "archive:false", `remove:${ids.extra}`, `remove:${ids.message}`]);
});

test("DM and close operations are single-flight on the same listing owner key", async () => {
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	let active = 0;
	let maximum = 0;
	const order = [];
	const key = listingOperationKey(ids.owner);
	assert.equal(key, `listing:${ids.owner}`);
	const first = withTeamFinderKey(key, async () => {
		active++;
		maximum = Math.max(maximum, active);
		order.push("first-start");
		await gate;
		order.push("first-end");
		active--;
	});
	await new Promise(resolve => setImmediate(resolve));
	const second = withTeamFinderKey(key, async () => {
		active++;
		maximum = Math.max(maximum, active);
		order.push("second-start");
		active--;
	});
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(order, ["first-start"]);
	release();
	await Promise.all([first, second]);
	assert.equal(maximum, 1);
	assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

test("permission sets match the exact forum and private-thread flows", () => {
	assert.deepEqual(new Set(TEAM_FINDER_FORUM_PERMISSIONS), new Set([
		PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
		PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageThreads, PermissionFlagsBits.ManageWebhooks,
	]));
	assert.equal(TEAM_FINDER_FORUM_PERMISSIONS.includes(PermissionFlagsBits.CreatePublicThreads), false);
	assert.deepEqual(new Set(TEAM_FINDER_CONVERSATION_PERMISSIONS), new Set([
		PermissionFlagsBits.ViewChannel, PermissionFlagsBits.CreatePrivateThreads,
		PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageThreads,
	]));
	assert.equal(TEAM_FINDER_CONVERSATION_PERMISSIONS.includes(PermissionFlagsBits.SendMessages), false);
});
