import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, corpusCaseSchema, corpusJsonl, parseCorpusJsonl } from "../dist/ai-corpus.js";
import { createCorpusApp } from "../dist/ai-corpus-server.js";
import { noTaskEventIsSafe } from "../dist/sync-ai-corpus.js";

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

test("no-task sampling excludes contextual sensitivity and manual overrides", () => {
	assert.equal(noTaskEventIsSafe({ message_assessments: [], decision: {} }), false);
	assert.equal(noTaskEventIsSafe({ message_assessments: [{ sensitivity: "safe" }], decision: {} }), false);
	assert.equal(noTaskEventIsSafe({ message_assessments: [{ sensitivity: "safe" }], decision: { windowSensitivity: "safe" } }), true);
	assert.equal(noTaskEventIsSafe({ message_assessments: [{}], decision: {} }), false);
	assert.equal(noTaskEventIsSafe({ message_assessments: [{ sensitivity: "uncertain" }], decision: {} }), false);
	assert.equal(noTaskEventIsSafe({ message_assessments: [], decision: { extractionOptions: { allowSensitiveContent: true } } }), false);
});

test("localhost corpus API requires its session token and uses ETags", async () => {
	let value = sampleCase();
	let etag = '"one"';
	const store = {
		async listCases() { return [{ id: value.id, status: value.adjudication.status, originType: value.origin.type, updatedAt: value.updatedAt, messageCount: 1, proposalCount: 1, preview: "sponsor" }]; },
		async getCase() { return { case: value, etag }; },
		async putCase(next, expected) {
			if (expected && expected !== etag) throw Object.assign(new Error("conflict"), { statusCode: 412 });
			value = next; etag = '"two"'; return { etag };
		},
		async exportIncluded() { return { schemaVersion: "v1", generatedAt: new Date().toISOString(), caseCount: 0, positiveCases: 0, negativeCases: 0, sha256: "hash" }; },
		async getExportManifest() { return null; },
	};
	const app = createCorpusApp({ store, token: "secret", assetsDirectory: "/does-not-matter", reviewer: "tester" });
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
