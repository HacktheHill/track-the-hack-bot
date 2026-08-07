import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, corpusCaseSchema, corpusJsonl, parseCorpusJsonl } from "../dist/ai-corpus.js";
import { blobEtagsEqual } from "../dist/ai-corpus-blob.js";
import { createCorpusApp } from "../dist/ai-corpus-server.js";
import { createDiscordCorpusRecovery, parseDiscordMessageUrl } from "../dist/discord-corpus-recovery.js";
import { discordReviewContext, noTaskEventIsSafe, noTaskEventSampleScore, reconcileCase, sampledSafeNoTaskEvents } from "../dist/sync-ai-corpus.js";

function sampleCase(status = "pending") {
	const now = "2026-07-29T12:00:00.000Z";
	return corpusCaseSchema.parse({
		schemaVersion: "v2",
		id: "case-1",
		origin: { type: "manual_scenario" },
		window: {
			id: "case-1", mode: "automatic",
			messages: [{ id: "m1", authorAlias: "Person A", text: "I will prepare the sponsor deck.", timestamp: now, contextRole: "primary" }],
			metadata: { projects: ["Partnerships Team"] },
			expected: { proposals: [{ action: "create", titleIncludes: ["sponsor", "deck"], projectName: "Partnerships Team", sourceMessageIds: ["m1"] }] },
		},
		adjudication: { status, exclusionReasons: status === "excluded" ? ["other"] : [], notes: status === "excluded" ? "Unusable capture." : "" },
		createdAt: now, updatedAt: now,
	});
}

test("shared corpus JSONL parsing reports line numbers and stable hashes", () => {
	const value = sampleCase().window;
	assert.deepEqual(parseCorpusJsonl(corpusJsonl([value])), [value]);
	assert.equal(contentHash({ b: 2, a: 1 }), contentHash({ a: 1, b: 2 }));
	assert.throws(() => parseCorpusJsonl(`${JSON.stringify(value)}\n{"bad":true}\n`), /line 2/);
});

test("corpus export integrity accepts equivalent Azure ETag formats", () => {
	assert.equal(blobEtagsEqual('"0x8DEF0678F8E6F23"', "0x8DEF0678F8E6F23"), true);
	assert.equal(blobEtagsEqual('"0x1"', "0x2"), false);
	assert.equal(blobEtagsEqual(undefined, undefined), true);
	assert.equal(blobEtagsEqual(undefined, "0x1"), false);
});

test("corpus cases reject unknown sources and invalid focal windows", () => {
	assert.throws(() => corpusCaseSchema.parse({ ...sampleCase(), origin: { type: "discord" } }));
	const withoutFocus = sampleCase();
	withoutFocus.window.messages[0].contextRole = "preceding";
	assert.throws(() => corpusCaseSchema.parse(withoutFocus), /exactly one/);
});

test("corpus exclusions require structured reasons and notes for other", () => {
	assert.throws(() => corpusCaseSchema.parse({ ...sampleCase(), adjudication: { status: "excluded", exclusionReasons: [], notes: "Missing context." } }), /exclusion reason/);
	assert.throws(() => corpusCaseSchema.parse({ ...sampleCase(), adjudication: { status: "excluded", exclusionReasons: ["other"], notes: "" } }), /reviewer notes/);
	assert.throws(() => corpusCaseSchema.parse({ ...sampleCase(), adjudication: { status: "included", exclusionReasons: ["missing_context"], notes: "" } }), /Only excluded/);
	assert.equal(corpusCaseSchema.parse({ ...sampleCase(), adjudication: { status: "excluded", exclusionReasons: ["missing_context", "missing_attachment"], notes: "" } }).adjudication.status, "excluded");
	assert.throws(() => corpusCaseSchema.parse({ ...sampleCase(), schemaVersion: "v1" }));
	assert.throws(() => corpusCaseSchema.parse({ ...sampleCase(), adjudication: { status: "approved", exclusionReasons: [], notes: "" } }));
});

test("correction cases require paired origin metadata and a changed expected value before inclusion", () => {
	const pending = sampleCase();
	pending.origin = {
		type: "reviewed_proposal", reviewKind: "incorrect_proposal",
		reviewFingerprint: contentHash(pending.window.expected.proposals),
	};
	assert.equal(corpusCaseSchema.parse(pending).adjudication.status, "pending");
	assert.throws(() => corpusCaseSchema.parse({ ...pending, origin: { ...pending.origin, reviewFingerprint: undefined } }), /provided together/);
	assert.throws(() => corpusCaseSchema.parse({ ...pending, adjudication: { ...pending.adjudication, status: "included" } }), /change or remove/);
	const corrected = structuredClone(pending);
	corrected.window.expected.proposals[0].titleIncludes = ["corrected"];
	corrected.adjudication.status = "included";
	assert.equal(corpusCaseSchema.parse(corrected).adjudication.status, "included");
	const removed = structuredClone(pending);
	removed.window.expected.proposals = [];
	removed.adjudication.status = "included";
	assert.equal(corpusCaseSchema.parse(removed).window.expected.proposals.length, 0);
});

test("Discord references remain review-only and use canonical message links", () => {
	const value = sampleCase();
	value.window.messages[0].channelId = "222";
	value.reviewContext = discordReviewContext([{ id: "111", channelId: "222" }], value.window, "333");
	const parsed = corpusCaseSchema.parse(value);
	assert.deepEqual(parsed.reviewContext.discordMessages.m1, {
		guildId: "333", channelId: "222", messageId: "111", url: "https://discord.com/channels/333/222/111",
	});
	assert.equal(parsed.window.messages[0].channelId, undefined);
	assert.equal(corpusJsonl([parsed.window]).includes("discord.com"), false);
	assert.equal(corpusJsonl([parsed.window]).includes("channelId"), false);
	parsed.reviewContext.discordMessages.m1.url = "https://example.com/not-discord";
	assert.throws(() => corpusCaseSchema.parse(parsed), /invalid URL/);
	const invalidReconstruction = sampleCase();
	invalidReconstruction.reviewContext = {
		discordMessages: { m1: { guildId: "333", channelId: "222", messageId: "111", url: "https://discord.com/channels/333/222/111" } },
		reconstruction: { recoveredAt: "2026-07-29T13:00:00.000Z", addedMessageIds: ["m2"] },
	};
	assert.throws(() => corpusCaseSchema.parse(invalidReconstruction), /unknown corpus message/);
});

test("Discord reference backfills preserve reviewed dispositions", async () => {
	const existing = sampleCase("excluded");
	existing.origin = { type: "reviewed_proposal", fingerprint: "same" };
	const next = sampleCase();
	next.origin = { type: "reviewed_proposal", fingerprint: "same" };
	next.window.expected.proposals[0].titleIncludes = ["source", "version"];
	next.reviewContext = discordReviewContext([{ id: "111", channelId: "222" }], next.window, "333");
	let written;
	const result = await reconcileCase({
		async getCase() { return { case: existing, etag: '"one"' }; },
		async putCase(value, etag) { written = { value, etag }; return { etag: '"two"' }; },
	}, next);
	assert.equal(result, "updated");
	assert.deepEqual(written.value.adjudication, existing.adjudication);
	assert.deepEqual(written.value.window, existing.window);
	assert.equal(written.value.reviewContext.discordMessages.m1.messageId, "111");
	assert.equal(written.etag, '"one"');
});

test("idempotent correction sync preserves human expected output and disposition", async () => {
	const seeded = sampleCase();
	const reviewFingerprint = contentHash(seeded.window.expected.proposals);
	seeded.origin = { type: "reviewed_proposal", fingerprint: "same-source", reviewKind: "incorrect_proposal", reviewFingerprint };
	const existing = structuredClone(seeded);
	existing.window.expected.proposals[0].titleIncludes = ["human", "correction"];
	existing.adjudication.status = "included";
	let written;
	assert.equal(await reconcileCase({
		async getCase() { return { case: existing, etag: '"one"' }; },
		async putCase(value) { written = value; },
	}, seeded), "unchanged");
	assert.equal(written, undefined);
});

test("Discord reference backfills preserve reconstructed evidence", async () => {
	const existing = sampleCase("excluded");
	existing.origin = { type: "reviewed_proposal", fingerprint: "same" };
	existing.window.messages.push({ id: "m2", authorAlias: "Person B", text: "Recovered context", timestamp: "2026-07-29T11:59:00.000Z", contextRole: "preceding" });
	existing.reviewContext = {
		discordMessages: {
			m1: { guildId: "333", channelId: "222", messageId: "111", url: "https://discord.com/channels/333/222/111" },
			m2: { guildId: "333", channelId: "222", messageId: "112", url: "https://discord.com/channels/333/222/112" },
		},
		reconstruction: { recoveredAt: "2026-07-29T13:00:00.000Z", baseFingerprint: "same", addedMessageIds: ["m2"] },
	};
	const next = sampleCase();
	next.origin = { type: "reviewed_proposal", fingerprint: "same" };
	next.reviewContext = discordReviewContext([{ id: "111", channelId: "222" }], next.window, "333");
	let written;
	assert.equal(await reconcileCase({
		async getCase() { return { case: existing, etag: '"one"' }; },
		async putCase(value, etag) { written = { value, etag }; return { etag: '"two"' }; },
	}, next), "unchanged");
	assert.equal(written, undefined);

	next.reviewContext.discordMessages.m1.messageId = "113";
	next.reviewContext.discordMessages.m1.url = "https://discord.com/channels/333/222/113";
	assert.equal(await reconcileCase({
		async getCase() { return { case: existing, etag: '"one"' }; },
		async putCase(value, etag) { written = { value, etag }; return { etag: '"two"' }; },
	}, next), "updated");
	assert.equal(written.value.reviewContext.discordMessages.m1.messageId, "113");
	assert.equal(written.value.reviewContext.discordMessages.m2.messageId, "112");
	assert.deepEqual(written.value.reviewContext.reconstruction.addedMessageIds, ["m2"]);
});

test("Discord recovery adds pseudonymous text evidence and resets adjudication", async () => {
	assert.deepEqual(parseDiscordMessageUrl("https://discord.com/channels/333/222/112"), {
		guildId: "333", channelId: "222", messageId: "112", url: "https://discord.com/channels/333/222/112",
	});
	assert.throws(() => parseDiscordMessageUrl("https://example.com/channels/333/222/112"), /canonical/);
	const value = sampleCase("excluded");
	value.origin = { type: "reviewed_proposal", fingerprint: "source-hash" };
	value.adjudication.notes = "Missing preceding context.";
	value.reviewContext = {
		discordMessages: { m1: { guildId: "333", channelId: "222", messageId: "111", url: "https://discord.com/channels/333/222/111" } },
	};
	const messages = new Map([
		["/channels/222/messages/111", {
			id: "111", channel_id: "222", author: { id: "10" }, content: "I will prepare the sponsor deck.", timestamp: "2026-07-29T12:00:00.000Z", type: 0, mentions: [], attachments: [],
		}],
		["/channels/222/messages/112", {
			id: "112", channel_id: "222", author: { id: "20" }, content: "Could <@10> answer this first?", timestamp: "2026-07-29T11:59:00.000Z", type: 0, mentions: [{ id: "10" }],
			attachments: [{ id: "900", filename: "question.png", content_type: "image/png", url: "https://cdn.discordapp.com/private" }],
		}],
	]);
	const recover = createDiscordCorpusRecovery({
		rest: { async get(route) { if (!messages.has(route)) throw new Error("missing"); return messages.get(route); } },
		guildId: "333", reviewer: "tester", now: () => "2026-07-29T13:00:00.000Z",
	});
	const preview = await recover(value, ["https://discord.com/channels/333/222/112"]);
	const recovered = preview.case.window.messages.find(message => message.id === "m2");
	assert.equal(recovered.authorAlias, "USER_1");
	assert.equal(recovered.text, "Could Person A answer this first?");
	assert.equal(recovered.contextRole, "preceding");
	assert.deepEqual(recovered.attachments, [{ id: "a1", name: "question.png", contentType: "image/png", url: "https://example.invalid/attachment/a1" }]);
	assert.equal(preview.case.adjudication.status, "pending");
	assert.equal(preview.case.adjudication.notes, "Missing preceding context.");
	assert.deepEqual(preview.case.adjudication.exclusionReasons, []);
	assert.deepEqual(preview.case.reviewContext.reconstruction, {
		recoveredAt: "2026-07-29T13:00:00.000Z", recoveredBy: "tester", baseFingerprint: "source-hash", addedMessageIds: ["m2"],
	});
	assert.equal(preview.case.reviewContext.discordMessages.m2.messageId, "112");
	assert.match(preview.warnings[0], /attachment metadata only/);
	const exported = corpusJsonl([preview.case.window]);
	assert.equal(exported.includes("discord.com"), false);
	assert.equal(exported.includes('"112"'), false);
	await assert.rejects(() => recover(value, ["https://discord.com/channels/444/222/112"]), /organizer guild/);
	await assert.rejects(() => recover(value, ["https://discord.com/channels/333/222/111"]), /already present/);
	await assert.rejects(() => recover(value, Array.from({ length: 41 }, (_, index) => `https://discord.com/channels/333/222/${1000 + index}`)), /between 1 and 40/);
});

test("no-task sampling excludes contextual sensitivity and manual overrides", () => {
	assert.equal(noTaskEventIsSafe({ message_assessments: [], decision: {} }), false);
	assert.equal(noTaskEventIsSafe({ message_assessments: [{ sensitivity: "safe" }], decision: {} }), false);
	assert.equal(noTaskEventIsSafe({ message_assessments: [{ sensitivity: "safe" }], decision: { windowSensitivity: "safe" } }), true);
	assert.equal(noTaskEventIsSafe({ message_assessments: [{}], decision: {} }), false);
	assert.equal(noTaskEventIsSafe({ message_assessments: [{ sensitivity: "uncertain" }], decision: {} }), false);
	assert.equal(noTaskEventIsSafe({ message_assessments: [], decision: { extractionOptions: { allowSensitiveContent: true } } }), false);
});

test("no-task sampling is stable, seeded, and applies safety before its cap", () => {
	const safe = id => ({ id, message_assessments: [{ sensitivity: "safe" }], decision: { windowSensitivity: "safe" } });
	const unsafe = { id: "unsafe", message_assessments: [{ sensitivity: "uncertain" }], decision: { windowSensitivity: "safe" } };
	const rows = [safe("3"), unsafe, safe("1"), safe("2")];
	const selected = sampledSafeNoTaskEvents(rows, 1, "seed-a", 2);
	assert.equal(selected.length, 2);
	assert.equal(selected.some(row => row.id === "unsafe"), false);
	assert.deepEqual(sampledSafeNoTaskEvents([...rows].reverse(), 1, "seed-a", 2).map(row => row.id), selected.map(row => row.id));
	assert.equal(noTaskEventSampleScore("1", "seed-a"), noTaskEventSampleScore("1", "seed-a"));
	assert.notEqual(noTaskEventSampleScore("1", "seed-a"), noTaskEventSampleScore("1", "seed-b"));
	assert.deepEqual(sampledSafeNoTaskEvents(rows, 0, "seed-a", 2), []);
});

test("localhost corpus API requires its session token and uses ETags", async () => {
	let value = sampleCase();
	let etag = '"one"';
	const store = {
		async listCases() { return [{ id: value.id, status: value.adjudication.status, originType: value.origin.type, reviewKind: "incorrect_proposal", updatedAt: value.updatedAt, messageCount: 1, proposalCount: 1, preview: "sponsor" }]; },
		async getCase() { return { case: value, etag }; },
		async putCase(next, expected) {
			if (expected && expected !== etag) throw Object.assign(new Error("conflict"), { statusCode: 412 });
			value = next; etag = '"two"'; return { etag };
		},
		async exportIncluded() { return { schemaVersion: "v1", generatedAt: new Date().toISOString(), caseCount: 0, positiveCases: 0, negativeCases: 0, sha256: "hash" }; },
		async getExportManifest() { return null; },
	};
	let recoveryCalls = 0;
	const app = createCorpusApp({
		store, token: "secret", assetsDirectory: "/does-not-matter", reviewer: "tester",
		async recoverContext(current, messageUrls) {
			recoveryCalls++;
			return { case: { ...current, adjudication: { status: "pending", exclusionReasons: [], notes: current.adjudication.notes } }, addedMessageIds: ["m2"], warnings: messageUrls };
		},
	});
	const server = app.listen(0, "127.0.0.1");
	await new Promise(resolve => server.once("listening", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No test server address");
		const base = `http://127.0.0.1:${address.port}`;
		assert.equal((await fetch(`${base}/api/summary`)).status, 401);
		const summary = await fetch(`${base}/api/summary`, { headers: { Cookie: "corpus_session=secret" } });
		assert.equal(summary.status, 200);
		assert.equal((await summary.json()).pending, 1);
		const correctionSearch = await fetch(`${base}/api/cases?query=incorrect_proposal`, { headers: { Cookie: "corpus_session=secret" } });
		assert.equal(correctionSearch.status, 200);
		assert.equal((await correctionSearch.json()).cases.length, 1);
		const unauthorizedRecovery = await fetch(`${base}/api/cases/case-1/reconstruction-preview`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etag: '"one"', messageUrls: ["url"] }),
		});
		assert.equal(unauthorizedRecovery.status, 401);
		assert.equal(recoveryCalls, 0);
		const staleRecovery = await fetch(`${base}/api/cases/case-1/reconstruction-preview`, {
			method: "POST", headers: { "Content-Type": "application/json", Cookie: "corpus_session=secret" }, body: JSON.stringify({ etag: '"stale"', messageUrls: ["url"] }),
		});
		assert.equal(staleRecovery.status, 409);
		const oversizedRecovery = await fetch(`${base}/api/cases/case-1/reconstruction-preview`, {
			method: "POST", headers: { "Content-Type": "application/json", Cookie: "corpus_session=secret" },
			body: JSON.stringify({ etag: '"one"', messageUrls: Array.from({ length: 41 }, (_, index) => `url-${index}`) }),
		});
		assert.equal(oversizedRecovery.status, 400);
		assert.equal(recoveryCalls, 0);
		const recovery = await fetch(`${base}/api/cases/case-1/reconstruction-preview`, {
			method: "POST", headers: { "Content-Type": "application/json", Cookie: "corpus_session=secret" }, body: JSON.stringify({ etag: '"one"', messageUrls: ["url"] }),
		});
		assert.equal(recovery.status, 200);
		assert.equal((await recovery.json()).etag, '"one"');
		assert.equal(recoveryCalls, 1);
		const included = sampleCase("included");
		const update = await fetch(`${base}/api/cases/case-1`, {
			method: "PUT", headers: { "Content-Type": "application/json", Cookie: "corpus_session=secret" },
			body: JSON.stringify({ case: included, etag: '"one"' }),
		});
		assert.equal(update.status, 200);
		assert.equal((await update.json()).case.adjudication.reviewedBy, "tester");
		const requested = sampleCase("included");
		requested.id = "case-2";
		requested.window.id = "case-2";
		requested.adjudication.reviewedBy = "untrusted-client";
		const created = await fetch(`${base}/api/cases`, {
			method: "POST", headers: { "Content-Type": "application/json", Cookie: "corpus_session=secret" },
			body: JSON.stringify({ case: requested }),
		});
		assert.equal(created.status, 201);
		const createdCase = (await created.json()).case;
		assert.equal(createdCase.adjudication.status, "pending");
		assert.equal(createdCase.adjudication.reviewedBy, undefined);
		assert.equal(createdCase.origin.type, "manual_scenario");
	} finally {
		await new Promise(resolve => server.close(resolve));
	}
});
