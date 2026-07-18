import assert from "node:assert/strict";
import test from "node:test";
import { corpusWindowSchema, runtimeProposalCandidates } from "../dist/evaluate-ai.js";
import { OpenProjectClient, workPackageChangesApplied } from "../dist/openproject.js";
import { explicitWorkPackageId, lexicalTitleSimilarity, OpenProjectRag, resolveProposalTarget, resolveProposedAction } from "../dist/rag.js";

test("RAG shadow mode never changes proposal actions", () => {
	assert.equal(resolveProposedAction("create", false), "create");
	assert.equal(resolveProposedAction("create", true), "create");
	assert.equal(resolveProposedAction("update", false), "no_action");
	assert.equal(resolveProposedAction("complete", true), "complete");
});

test("RAG never converts actions and requires a target for existing work", () => {
	assert.equal(resolveProposedAction("update", false), "no_action");
	assert.equal(resolveProposedAction("complete", false), "no_action");
	assert.equal(resolveProposedAction("reopen", true), "reopen");
});

test("exact OpenProject references are resolved without semantic phrase matching", () => {
	assert.equal(explicitWorkPackageId(["Update task #2149 with the revised colors"]), 2149);
	assert.equal(explicitWorkPackageId(["See https://projects.example.org/work_packages/42/activity"], "https://projects.example.org"), 42);
	assert.equal(explicitWorkPackageId(["See https://other.example/work_packages/42"], "https://projects.example.org"), undefined);
	assert.equal(explicitWorkPackageId(["Update the existing sponsor task"]), undefined);
});

test("an invalid explicit target never falls back to a semantic match", async () => {
	const result = await resolveProposalTarget({
		action: "update",
		sourceTexts: ["Update task #42"],
		openProjectBaseUrl: "https://projects.example.org",
		projectId: 7,
		ragMode: "review",
		suggestedMatch: { workPackageId: 99, similarity: 0.9 },
		workPackage: async id => ({ id, subject: "Other", lockVersion: 1, project: { id: 8 }, _links: {} }),
	});
	assert.equal(result.action, "no_action");
	assert.equal(result.match, undefined);
	assert.equal(result.target, undefined);
});

test("OpenProject work packages follow HAL pagination beyond the first page", async () => {
	const originalFetch = globalThis.fetch;
	const urls = [];
	globalThis.fetch = async url => {
		urls.push(String(url));
		const second = String(url).includes("offset=500");
		return Response.json({
			_embedded: { elements: [{ id: second ? 501 : 1, subject: second ? "Later" : "First", lockVersion: 1, _links: {} }] },
			_links: second ? {} : { next: { href: "/api/v3/work_packages?offset=500&pageSize=500" } },
		});
	};
	try {
		const client = new OpenProjectClient({
			OPENPROJECT_BASE_URL: "https://openproject.example",
			OPENPROJECT_API_KEY: "secret",
			OPENPROJECT_CACHE_TTL_MS: 1000,
		});
		const packages = await client.workPackages(9);
		assert.deepEqual(packages.map(item => item.id), [1, 501]);
		assert.equal(urls.length, 2);
		assert.equal(urls[1], "https://openproject.example/api/v3/work_packages?offset=500&pageSize=500");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("OpenProject updates reject stale proposal lock versions before PATCH", async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		return Response.json({ id: 42, subject: "Changed task", lockVersion: 4, _links: {} });
	};
	try {
		const client = new OpenProjectClient({ OPENPROJECT_BASE_URL: "https://openproject.example", OPENPROJECT_API_KEY: "secret", OPENPROJECT_CACHE_TTL_MS: 1000 });
		await assert.rejects(client.updateWorkPackage(42, { subject: "Proposed" }, 3), /changed since this proposal/);
		assert.equal(calls, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("OpenProject updates enforce the freshly fetched lock version", async () => {
	const originalFetch = globalThis.fetch;
	let payload;
	globalThis.fetch = async (_url, init = {}) => {
		if ((init.method ?? "GET") === "PATCH") {
			payload = JSON.parse(init.body);
			return Response.json({ id: 42, subject: "Updated", lockVersion: 6, _links: {} });
		}
		return Response.json({ id: 42, subject: "Current", lockVersion: 5, _links: {} });
	};
	try {
		const client = new OpenProjectClient({ OPENPROJECT_BASE_URL: "https://openproject.example", OPENPROJECT_API_KEY: "secret", OPENPROJECT_CACHE_TTL_MS: 1000 });
		await client.updateWorkPackage(42, { subject: "Updated", lockVersion: 999 }, 5);
		assert.equal(payload.lockVersion, 5);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("already-applied OpenProject changes can recover a lost checkpoint", () => {
	const workPackage = {
		id: 42, subject: "Updated", description: { raw: "New scope" }, lockVersion: 6,
		dueDate: "2026-07-31", estimatedTime: "PT4H",
		_links: { assignee: { href: "/api/v3/users/8" } }, customField2: { href: "/api/v3/custom_options/3" },
	};
	assert.equal(workPackageChangesApplied(workPackage, {
		subject: "Updated", description: { format: "markdown", raw: "New scope" }, dueDate: "2026-07-31",
		estimatedTime: "PT4H", _links: { assignee: { href: "/api/v3/users/8" } }, customField2: { href: "/api/v3/custom_options/3" },
	}), true);
	assert.equal(workPackageChangesApplied(workPackage, { dueDate: "2026-08-01" }), false);
});

test("OpenProject comments are Markdown activities and deduplicate by proposal marker", async () => {
	const originalFetch = globalThis.fetch;
	const requests = [];
	globalThis.fetch = async (url, init = {}) => {
		requests.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
		if ((init.method ?? "GET") === "POST") return Response.json({ id: 9, comment: { raw: init.body }, _links: {} }, { status: 201 });
		return Response.json({ _embedded: { elements: [] }, _links: {} });
	};
	try {
		const client = new OpenProjectClient({ OPENPROJECT_BASE_URL: "https://openproject.example", OPENPROJECT_API_KEY: "secret", OPENPROJECT_CACHE_TTL_MS: 1000 });
		const activity = await client.commentWorkPackage(42, "## Update\n\n- Ship it", ["https://discord.com/channels/1/2/3"], "proposal");
		assert.equal(activity.id, 9);
		assert.equal(requests[1].url, "https://openproject.example/api/v3/work_packages/42/activities");
		assert.equal(requests[1].method, "POST");
		assert.match(requests[1].body.comment.raw, /track-the-hack-proposal:proposal:comment/);
		assert.match(requests[1].body.comment.raw, /## Source/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("OpenProject comments reuse an existing correlated activity", async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		return Response.json({ _embedded: { elements: [{ id: 7, comment: { raw: "<!-- track-the-hack-proposal:proposal:comment -->" } }] }, _links: {} });
	};
	try {
		const client = new OpenProjectClient({ OPENPROJECT_BASE_URL: "https://openproject.example", OPENPROJECT_API_KEY: "secret", OPENPROJECT_CACHE_TTL_MS: 1000 });
		assert.equal((await client.commentWorkPackage(42, "Update", [], "proposal")).id, 7);
		assert.equal(calls, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("RAG sync includes category projects configured in the database and records success", async () => {
	const requestedProjects = [];
	const syncStates = [];
	const db = {
		categoryProjectIds: async () => [30],
		embeddingIsCurrent: async () => true,
		deleteEmbeddingsExcept: async () => {},
		recordEmbeddingSync: async error => syncStates.push(error ?? null),
	};
	const rag = new OpenProjectRag(
		{ OPENPROJECT_RAG_MODE: "shadow", categoryProjects: { a: 10 }, teamRoles: { role: { projectId: 20 } } },
		db,
		{ workPackages: async projectId => { requestedProjects.push(projectId); return []; } },
		{ enabled: true },
	);
	assert.deepEqual(await rag.sync(), { indexed: 0, projects: 3 });
	assert.deepEqual(requestedProjects.sort((a, b) => a - b), [10, 20, 30]);
	assert.deepEqual(syncStates, [null]);
});

test("RAG combines semantic candidates with lexical title matches", async () => {
	const rag = new OpenProjectRag(
		{ OPENPROJECT_RAG_MODE: "review" },
		{
			similarEmbeddings: async () => [{ workPackageId: 1, projectId: 7, lockVersion: 1, subject: "Unrelated planning", description: "", similarity: 0.7 }],
			embeddingTitles: async () => [
				{ workPackageId: 1, projectId: 7, lockVersion: 1, subject: "Unrelated planning", description: "" },
				{ workPackageId: 2, projectId: 7, lockVersion: 3, subject: "Publish sponsor prospectus", description: "" },
			],
		},
		{},
		{ enabled: true, embed: async () => ({ embeddings: [[0.1]], model: "test", dimensions: 1 }) },
	);
	const matches = await rag.findSimilar(7, "Publish the sponsor prospectus", "Draft it");
	assert.equal(matches[0].workPackageId, 2);
	assert.ok(matches[0].similarity > 0.7);
	assert.equal(lexicalTitleSimilarity("Publish sponsor prospectus", "Publish the sponsor prospectus"), 1);
	assert.ok(lexicalTitleSimilarity(
		"Update sponsorship package tier table",
		"Revise sponsorship tiers graphic layout and colors",
	) >= 0.3);
});

test("AI evaluator uses production grounding and target semantics for every action", () => {
	const candidate = { proposed_action: "update", source_message_ids: ["m1"], relevant_attachment_ids: [] };
	const messages = [{ id: "m1", authorAlias: "USER_1", text: "Update it", timestamp: "2026-07-16T00:00:00Z", priority: true }];
	assert.deepEqual(runtimeProposalCandidates([candidate], messages), []);
	assert.deepEqual(runtimeProposalCandidates([candidate], messages, { availableTargetSourceMessageIds: [["m1"]] }), [candidate]);
	assert.deepEqual(runtimeProposalCandidates([{ ...candidate, source_message_ids: ["other"] }], messages), []);
});

test("AI evaluator corpus accepts expected proposal lists", () => {
	const parsed = corpusWindowSchema.parse({
		id: "window", mode: "automatic", messages: [{ id: "m1", authorAlias: "USER_1", text: "Do it", timestamp: "2026-07-16T00:00:00Z", priority: true }],
		expected: { proposals: [{ action: "create", titleIncludes: ["task"], sourceMessageIds: ["m1"] }] },
	});
	assert.equal(parsed.expected.proposals[0].action, "create");
	assert.deepEqual(parsed.expected.proposals[0].sourceMessageIds, ["m1"]);
});

test("automatic evaluation windows mirror one production focal message", () => {
	assert.throws(() => corpusWindowSchema.parse({
		id: "window", mode: "automatic",
		messages: [
			{ id: "m1", authorAlias: "USER_1", text: "First", timestamp: "2026-07-16T00:00:00Z", priority: true },
			{ id: "m2", authorAlias: "USER_2", text: "Second", timestamp: "2026-07-16T00:01:00Z" },
		],
		expected: { proposals: [] },
	}), /final position/);
});
