import assert from "node:assert/strict";
import test from "node:test";

import {
	createOutreachEnvelope,
	normalizeExcerpt,
	outreachEvidenceCommand,
	sendOutreachEvidence,
	signOutreachRequest,
} from "../dist/outreach.js";

test("outreach command is a stable message context command", () => {
	const command = outreachEvidenceCommand.toJSON();
	assert.equal(command.name, "Send as outreach evidence");
	assert.equal(command.type, 3);
});

test("selected messages become minimized conservative evidence", () => {
	const envelope = createOutreachEnvelope({
		guildId: "1234567890",
		channelId: "1234567891",
		id: "1234567892",
		author: {
			id: "1234567893",
			globalName: "Author Name",
			displayName: "Author Name",
			username: "author",
		},
		member: null,
		createdAt: new Date("2026-07-17T12:00:00.000Z"),
		content: "  Relevant\r\nmessage  ",
	});
	assert.deepEqual(envelope, {
		schemaVersion: 1,
		guildId: "1234567890",
		channelId: "1234567891",
		messageId: "1234567892",
		author: { id: "1234567893", displayName: "Author Name" },
		occurredAt: "2026-07-17T12:00:00.000Z",
		discordUrl: "https://discord.com/channels/1234567890/1234567891/1234567892",
		excerpt: "Relevant\nmessage",
		entities: [],
		proposedInteractionType: "OTHER",
		confidence: 0,
		redactionStatus: "REVIEW_REQUIRED",
	});
});

test("excerpt normalization rejects empty messages and applies its bound", () => {
	assert.throws(() => normalizeExcerpt("   "), /no text content/);
	assert.equal(normalizeExcerpt("x".repeat(5_000)).length, 4_000);
});

test("request signature changes with bound request fields", () => {
	const body = Buffer.from("body");
	const signature = signOutreachRequest("s".repeat(32), "POST", "/path", "time", "nonce", body);
	assert.match(signature, /^[a-f0-9]{64}$/);
	assert.notEqual(
		signOutreachRequest("s".repeat(32), "POST", "/path", "time", "other-nonce", body),
		signature,
	);
});

test("client sends one signed JSON envelope and requires HTTP 202", async () => {
	let captured;
	const fetcher = async (url, init) => {
		captured = { url: String(url), init };
		return new Response(null, { status: 202 });
	};
	const config = {
		OUTREACH_SERVICE_URL: "https://outreach.internal.example",
		OUTREACH_DISCORD_KEY_ID: "key-1",
		OUTREACH_DISCORD_SIGNING_SECRET: "s".repeat(32),
		ORGANIZER_GUILD_ID: "1234567890",
		ORGANIZER_GUILD_ORGANIZER_ROLE_ID: "1234567894",
		allowedChannelIds: new Set(["1234567891"]),
	};
	await sendOutreachEvidence(
		config,
		{
			schemaVersion: 1,
			guildId: "1234567890",
			channelId: "1234567891",
			messageId: "1234567892",
			author: { id: "1234567893", displayName: "Author" },
			occurredAt: "2026-07-17T12:00:00.000Z",
			discordUrl: "https://discord.com/channels/1234567890/1234567891/1234567892",
			excerpt: "Evidence",
			entities: [],
			proposedInteractionType: "OTHER",
			confidence: 0,
			redactionStatus: "REVIEW_REQUIRED",
		},
		fetcher,
	);
	assert.equal(captured.url, "https://outreach.internal.example/api/internal/discord-evidence");
	assert.equal(captured.init.headers["x-ctn-service"], "track-the-hack-bot");
	assert.match(captured.init.headers["x-ctn-signature"], /^[a-f0-9]{64}$/);
	assert.equal(JSON.parse(captured.init.body.toString()).excerpt, "Evidence");
	await assert.rejects(
		() => sendOutreachEvidence(config, {
			schemaVersion: 1,
			guildId: "1234567890",
			channelId: "1234567891",
			messageId: "1234567892",
			author: { id: "1234567893", displayName: "Author" },
			occurredAt: "2026-07-17T12:00:00.000Z",
			discordUrl: "https://discord.com/channels/1234567890/1234567891/1234567892",
			excerpt: "Evidence",
			entities: [],
			proposedInteractionType: "OTHER",
			confidence: 0,
			redactionStatus: "REVIEW_REQUIRED",
		}, async () => new Response(null, { status: 400 })),
		/rejected/,
	);
});
