import assert from "node:assert/strict";
import test from "node:test";
import { corpusWindowSchema, isRuntimeCreateCandidate } from "../dist/evaluate-ai.js";
import { OpenProjectClient, workPackageChangesApplied } from "../dist/openproject.js";
import { explicitlyReferencesExistingWork, lexicalTitleSimilarity, OpenProjectRag, resolveProposedAction } from "../dist/rag.js";

test("RAG shadow mode never changes proposal actions", () => {
	assert.equal(resolveProposedAction("create", "shadow", true), "create");
	assert.equal(resolveProposedAction("update", "shadow", true), "no_action");
	assert.equal(resolveProposedAction("complete", "off", true), "no_action");
	assert.equal(resolveProposedAction("create", "review", true), "update");
	assert.equal(resolveProposedAction("complete", "review", true), "complete");
});

test("unmatched provisional updates fall back to creation only for new ideas", () => {
	assert.equal(resolveProposedAction("update", "review", false, false), "create");
	assert.equal(resolveProposedAction("update", "review", false, true), "no_action");
	assert.equal(resolveProposedAction("complete", "review", false, false), "no_action");
	assert.equal(explicitlyReferencesExistingWork(["What if we reach out to the student union for bulk fruit prices?"]), false);
	assert.equal(explicitlyReferencesExistingWork(["Add this information to the task"]), true);
	assert.equal(explicitlyReferencesExistingWork(["Update task #2149 with the revised colors"]), true);
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

test("AI evaluator uses automatic-runtime create candidate semantics", () => {
	const candidate = {
		proposed_action: "create", completion_state: "incomplete", significance_score: 0.7, context_relation: "unclear",
	};
	assert.equal(isRuntimeCreateCandidate(candidate, 0.5), true);
	assert.equal(isRuntimeCreateCandidate({ ...candidate, completion_state: "completed" }, 0.5), false);
	assert.equal(isRuntimeCreateCandidate({ ...candidate, significance_score: 0.49 }, 0.5), false);
	assert.equal(isRuntimeCreateCandidate({ ...candidate, proposed_action: "update" }, 0.5), false);
});

test("AI evaluator corpus accepts optional action, completion, and relevance expectations", () => {
	const parsed = corpusWindowSchema.parse({
		id: "window", messages: [{ id: "m1", authorAlias: "USER_1", text: "Do it", timestamp: "2026-07-16T00:00:00Z" }],
		expected: { taskExists: true, action: "create", completion: "incomplete", relevance: { m1: "relevant" } },
	});
	assert.equal(parsed.expected.action, "create");
	assert.equal(parsed.expected.completion, "incomplete");
	assert.equal(parsed.expected.relevance.m1, "relevant");
});
