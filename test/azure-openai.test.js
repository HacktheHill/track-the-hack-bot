import assert from "node:assert/strict";
import test from "node:test";
import { automaticCandidateEligible, AzureTaskExtractor, containsSensitiveContent, mergeRelatedTaskCandidates, minimizeText, normalizeExtractedDate, sensitiveContentReasons, shouldReconcileTaskProposals, shouldSelectTaskContext } from "../dist/azure-openai.js";
import { AzureChatLimiter } from "../dist/azure-chat-limiter.js";

test("minimizeText removes common credentials and personal contact data", () => {
	const value = minimizeText(
		"api_key=super-secret email person@example.com phone 613-555-1212 https://discord.gg/example",
	);
	assert.equal(value.includes("super-secret"), false);
	assert.equal(value.includes("person@example.com"), false);
	assert.equal(value.includes("613-555-1212"), false);
	assert.equal(value.includes("discord.gg"), false);
	assert.match(value, /REDACTED_CREDENTIAL/);
});

test("minimizeText preserves ordinary task discussion", () => {
	assert.equal(
		minimizeText("USER_1 will finish the landing page by Friday."),
		"USER_1 will finish the landing page by Friday.",
	);
});

test("extracted dates are normalized or discarded before review", () => {
	assert.equal(normalizeExtractedDate("2026-07-28T12:30:00Z"), "2026-07-28");
	assert.equal(normalizeExtractedDate("2026-02-30"), null);
	assert.equal(normalizeExtractedDate("07/28/2026"), null);
});

test("auxiliary AI stages run only when they add material value", () => {
	assert.equal(shouldSelectTaskContext(24), false);
	assert.equal(shouldSelectTaskContext(25), true);
	assert.equal(shouldReconcileTaskProposals(1, 0), false);
	assert.equal(shouldReconcileTaskProposals(2, 0), true);
	assert.equal(shouldReconcileTaskProposals(1, 1), true);
	assert.equal(shouldReconcileTaskProposals(0, 1), false);
});

const config = {
	AZURE_OPENAI_MAX_COMPLETION_TOKENS: 1024,
	OPENPROJECT_AI_MAX_CONTEXT_CHARS: 16000,
	AZURE_OPENAI_ENDPOINT: "https://azure.example",
	AZURE_OPENAI_DEPLOYMENT: "task-extractor",
	AZURE_OPENAI_API_VERSION: "v1",
	AZURE_OPENAI_CHAT_MAX_CONCURRENCY: 10,
	AZURE_OPENAI_CHAT_MIN_INTERVAL_MS: 0,
};

test("Azure chat limiter is FIFO, bounds concurrency, and removes queued aborts", async () => {
	const limiter = new AzureChatLimiter(1, 0);
	const order = [];
	let releaseFirst;
	let markFirstStarted;
	const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
	const first = limiter.run("deployment", undefined, async () => {
		order.push("first");
		markFirstStarted();
		await new Promise(resolve => { releaseFirst = resolve; });
		return "first";
	});
	await firstStarted;
	const aborted = new AbortController();
	const second = limiter.run("deployment", aborted.signal, async () => { order.push("second"); return "second"; });
	const third = limiter.run("deployment", undefined, async () => { order.push("third"); return "third"; });
	aborted.abort();
	releaseFirst();
	assert.equal(await first, "first");
	await assert.rejects(second, error => error.name === "AbortError");
	assert.equal(await third, "third");
	assert.deepEqual(order, ["first", "third"]);
});

test("Azure chat limiter applies Retry-After cooldown across queued attempts", async () => {
	const limiter = new AzureChatLimiter(1, 0);
	const started = [];
	const first = limiter.run("deployment", undefined, async () => {
		started.push(Date.now());
		return new Response(null, { status: 429, headers: { "retry-after-ms": "30" } });
	});
	const second = limiter.run("deployment", undefined, async () => {
		started.push(Date.now());
		return new Response(null, { status: 200 });
	});
	await Promise.all([first, second]);
	assert.ok(started[1] - started[0] >= 25);
});

test("Azure chat limiter spaces attempt starts by the configured interval", async () => {
	const limiter = new AzureChatLimiter(2, 25);
	const started = [];
	await Promise.all([1, 2].map(() => limiter.run("deployment", undefined, async () => {
		started.push(Date.now());
		return "ok";
	})));
	assert.ok(started[1] - started[0] >= 20);
});

test("Azure extractor authenticates, bounds output, and uses the configured deployment", async () => {
	const originalFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, init) => {
		request = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
		return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tasks: [], ambiguities: [] }) } }] }), { status: 200 });
	};
	try {
		const extractor = new AzureTaskExtractor(config, async () => "managed-identity-token");
		const extraction = await extractor.extract(
			[{ id: "m1", authorAlias: "USER_1", text: "Ship it", timestamp: "2026-07-13T00:00:00Z", contextRole: "primary" }],
			{ mode: "manual", metadata: { priorities: ["High"], sizes: ["Small"], projects: ["Communications Team"] } },
		);
		assert.equal(request.url, "https://azure.example/openai/v1/chat/completions");
		assert.equal(request.body.model, "task-extractor");
		assert.equal(request.body.max_completion_tokens, 1024);
		assert.equal("max_tokens" in request.body, false);
		assert.equal("temperature" in request.body, false);
		assert.equal(request.headers.Authorization, "Bearer managed-identity-token");
		assert.match(request.body.messages[0].content, /Extract plausible work candidates broadly/);
		assert.match(request.body.messages[0].content, /intentionally requested manual extraction/);
		assert.match(request.body.messages[0].content, /Group requirements and feedback/);
		assert.match(request.body.messages[0].content, /OpenProject tracking state is different from artifact state/);
		assert.match(request.body.messages[0].content, /Use proposed_action=create when.*existing website/);
		assert.match(request.body.messages[0].content, /same work_item_key/);
		assert.match(request.body.messages[0].content, /timestamps/);
		assert.match(request.body.messages[0].content, /priority_name must exactly match one of: High/);
		assert.match(request.body.messages[0].content, /size_name must exactly match one of: Small/);
		assert.match(request.body.messages[0].content, /project_name must exactly match one of: Communications Team/);
		assert.match(request.body.messages[0].content, /content_intent=update_note/);
		assert.match(request.body.messages[0].content, /only explicitly requested existing-task metadata changes/);
		assert.match(request.body.messages[0].content, /do not invent missing objectives/i);
		assert.match(request.body.messages[0].content, /Keep one cohesive sentence or paragraph as prose/);
		assert.match(request.body.messages[0].content, /two or more independently actionable requirements/);
		assert.match(request.body.messages[0].content, /source URLs are retained internally.*intentionally omitted from OpenProject content/);
		assert.equal(request.body.messages[0].content.includes("application adds verified links"), false);
		assert.match(request.body.messages[0].content, /human review decides whether any candidate is applied/i);
		assert.ok(request.body.response_format.json_schema.schema.properties.tasks.items.required.includes("content_intent"));
		assert.equal(request.body.response_format.json_schema.schema.properties.tasks.items.required.includes("automatic_eligibility"), false);
		assert.ok(request.body.response_format.json_schema.schema.properties.tasks.items.required.includes("work_item_key"));
		assert.ok(request.body.response_format.json_schema.schema.properties.tasks.items.required.includes("project_name"));
		assert.equal(request.body.response_format.json_schema.schema.properties.tasks.items.properties.work_item_key.minLength, 1);
		assert.equal(request.body.response_format.json_schema.schema.properties.tasks.items.required.includes("trigger_kind"), false);
		assert.equal(request.body.response_format.json_schema.schema.properties.tasks.items.required.includes("lifecycle"), false);
		assert.equal("message_assessments" in request.body.response_format.json_schema.schema.properties, false);
		assert.equal(request.body.response_format.json_schema.schema.properties.tasks.items.properties.significance_score, undefined);
		assert.deepEqual(request.body.response_format.json_schema.schema.properties.tasks.items.properties.proposed_action.enum, ["create", "update", "complete", "reopen"]);
		assert.equal(request.body.response_format.json_schema.schema.properties.tasks.items.properties.metadata_change_fields.maxItems, 4);
		assert.deepEqual(JSON.parse(request.body.messages[1].content[0].text)[0], {
			id: "m1", authorAlias: "USER_1", text: "Ship it",
			timestamp: "2026-07-13T00:00:00Z", contextRole: "primary",
		});
		assert.deepEqual(extraction.inputMessages, [{
			id: "m1", authorAlias: "USER_1", text: "Ship it",
			timestamp: "2026-07-13T00:00:00Z", contextRole: "primary",
		}]);
		assert.deepEqual(extraction.metadata, { priorities: ["High"], sizes: ["Small"], projects: ["Communications Team"] });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Azure extractor retries transient rate limits using provider guidance", async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		if (calls === 1) return Response.json({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after-ms": "0" } });
		return Response.json({ choices: [{ message: { content: JSON.stringify({ tasks: [], ambiguities: [] }) } }] });
	};
	try {
		const result = await new AzureTaskExtractor(config, async () => "token").extract([
			{ id: "m1", authorAlias: "USER_1", text: "Ship it", timestamp: "2026-07-13T00:00:00Z", contextRole: "primary" },
		]);
		assert.equal(calls, 2);
		assert.deepEqual(result.result.tasks, []);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Azure extractor bounds persistent rate-limit retries", async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		return Response.json({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after-ms": "0" } });
	};
	try {
		await assert.rejects(
			new AzureTaskExtractor(config, async () => "token").extract([
				{ id: "m1", authorAlias: "USER_1", text: "Ship it", timestamp: "2026-07-13T00:00:00Z", contextRole: "primary" },
			]),
			/429/,
		);
		assert.equal(calls, 3);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("context selection uses semantic boundaries and retains reply ancestry", async () => {
	const originalFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (_url, init) => {
		request = JSON.parse(init.body);
		return Response.json({ choices: [{ message: { content: JSON.stringify({ selected_message_ids: ["m3"] }) } }] });
	};
	try {
		const result = await new AzureTaskExtractor(config, async () => "token").selectContext([
			{ id: "m1", authorAlias: "USER_1", text: "Prepare the sponsor deck", timestamp: "2026-07-01T00:00:00Z" },
			{ id: "m2", authorAlias: "USER_2", text: "Use the new benefits", timestamp: "2026-07-10T00:00:00Z", replyTo: "m1" },
			{ id: "m3", authorAlias: "USER_1", text: "Please finish this", timestamp: "2026-07-20T00:00:00Z", replyTo: "m2", contextRole: "primary" },
			{ id: "m4", authorAlias: "USER_3", text: "Unrelated venue question", timestamp: "2026-07-20T00:01:00Z" },
		], ["m3"]);
		assert.deepEqual(result.messages.map(message => message.id), ["m1", "m2", "m3"]);
		assert.equal(request.response_format.json_schema.name, "discord_context_selection_v1");
		assert.match(request.messages[0].content, /both the subject has materially changed and the elapsed time/);
		assert.match(request.messages[0].content, /replyTo links upward/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("proposal reconciliation revises the best pending proposal and supersedes duplicates", async () => {
	const originalFetch = globalThis.fetch;
	let request;
	const candidate = {
		title: "Finish sponsor deck", work_item_key: "sponsor-deck", description: "Finish the deck with the new benefits.", assignee_alias: null,
		start_date: null, due_date: null, priority_name: null, size_name: null, project_name: null, estimated_hours: null,
		source_message_ids: ["m2"], relevant_attachment_ids: [], evidence: "The focal reply requests completion.",
		proposed_action: "create", content_intent: "none", metadata_change_fields: [],
	};
	globalThis.fetch = async (_url, init) => {
		request = JSON.parse(init.body);
		return Response.json({ choices: [{ message: { content: JSON.stringify({
			proposals: [{ pending_proposal_id: "pending-best", candidate: { ...candidate, description: "USER_1 should finish the deck with the new benefits." } }],
			superseded_pending_proposal_ids: ["pending-duplicate"],
		}) } }] });
	};
	try {
		const result = await new AzureTaskExtractor(config, async () => "token").reconcileProposals(
			[{ id: "m2", authorAlias: "USER_1", text: "Finish the sponsor deck with the new benefits", timestamp: "2026-07-20T00:00:00Z", contextRole: "primary" }],
			[candidate],
			[
				{ id: "pending-best", title: "Sponsor deck", description: "Finish the deck.", action: "create", sourceMessageIds: ["m1"] },
				{ id: "pending-duplicate", title: "Update sponsor benefits", description: "Add benefits.", action: "create", workItemKey: "sponsor-deck", sourceMessageIds: ["m0"] },
			],
		);
		assert.equal(result.proposals[0].pendingProposalId, "pending-best");
		assert.equal(result.proposals[0].candidate.description.includes("USER_1"), false);
		assert.deepEqual(result.supersededPendingProposalIds, ["pending-duplicate"]);
		assert.equal(request.response_format.json_schema.name, "discord_proposal_reconciliation_v1");
		assert.match(request.messages[0].content, /Split lists into separate proposals/);
		assert.equal(JSON.parse(request.messages[1].content).pendingProposals.length, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("proposal reconciliation does not conflate distinct tasks from one source message", async () => {
	const originalFetch = globalThis.fetch;
	const candidate = {
		title: "Publish the venue map", work_item_key: "venue-map", description: "Publish the final map.", assignee_alias: null,
		start_date: null, due_date: null, priority_name: null, size_name: null, project_name: null, estimated_hours: null,
		source_message_ids: ["m1"], relevant_attachment_ids: [], evidence: "The map is ready.",
		proposed_action: "create", content_intent: "none", metadata_change_fields: [],
	};
	globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({
		proposals: [{ pending_proposal_id: "other", candidate }], superseded_pending_proposal_ids: ["other"],
	}) } }] });
	try {
		const result = await new AzureTaskExtractor(config, async () => "token").reconcileProposals(
			[{ id: "m1", authorAlias: "USER_1", text: "Publish the map and order volunteer shirts", timestamp: "2026-07-20T00:00:00Z", contextRole: "primary" }],
			[candidate],
			[{ id: "other", title: "Order volunteer shirts", description: "Order shirts.", action: "create", workItemKey: "volunteer-shirts", sourceMessageIds: ["m1"] }],
		);
		assert.equal(result.proposals[0].pendingProposalId, undefined);
		assert.deepEqual(result.supersededPendingProposalIds, []);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("invalid reconciliation grounding falls back to valid extracted candidates", async () => {
	const originalFetch = globalThis.fetch;
	const candidate = {
		title: "Publish the venue map", work_item_key: "venue-map", description: "Publish the final map.", assignee_alias: null,
		start_date: null, due_date: null, priority_name: null, size_name: null, project_name: null, estimated_hours: null,
		source_message_ids: ["m1"], relevant_attachment_ids: [], evidence: "The map is ready.",
		proposed_action: "create", content_intent: "none", metadata_change_fields: [],
	};
	globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({
		proposals: [{ pending_proposal_id: null, candidate: { ...candidate, source_message_ids: ["unknown"] } }],
		superseded_pending_proposal_ids: [],
	}) } }] });
	try {
		const result = await new AzureTaskExtractor(config, async () => "token").reconcileProposals(
			[{ id: "m1", authorAlias: "USER_1", text: "Publish the map", timestamp: "2026-07-20T00:00:00Z", contextRole: "primary" }],
			[candidate], [],
		);
		assert.deepEqual(result.proposals.map(item => item.candidate.source_message_ids), [["m1"]]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("one pending proposal cannot be assigned to multiple canonical tasks", async () => {
	const originalFetch = globalThis.fetch;
	const candidate = {
		title: "Publish the venue map", work_item_key: "venue-map", description: "Publish the final map.", assignee_alias: null,
		start_date: null, due_date: null, priority_name: null, size_name: null, project_name: null, estimated_hours: null,
		source_message_ids: ["m1"], relevant_attachment_ids: [], evidence: "The map is ready.",
		proposed_action: "create", content_intent: "none", metadata_change_fields: [],
	};
	globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({
		proposals: [
			{ pending_proposal_id: "pending", candidate },
			{ pending_proposal_id: "pending", candidate: { ...candidate, title: "Publish the parking map", work_item_key: "parking-map" } },
		],
		superseded_pending_proposal_ids: [],
	}) } }] });
	try {
		const result = await new AzureTaskExtractor(config, async () => "token").reconcileProposals(
			[{ id: "m1", authorAlias: "USER_1", text: "Publish both maps", timestamp: "2026-07-20T00:00:00Z", contextRole: "primary" }],
			[candidate],
			[{ id: "pending", title: "Publish the venue map", description: "Publish it.", action: "create", workItemKey: "venue-map", sourceMessageIds: ["old"] }],
		);
		assert.deepEqual(result.proposals.map(item => item.pendingProposalId), ["pending", undefined]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("proposal reconciliation bounds cached pending proposal content", async () => {
	const originalFetch = globalThis.fetch;
	let request;
	const candidate = {
		title: "Publish the venue map", work_item_key: "venue-map", description: "Publish the final map.", assignee_alias: null,
		start_date: null, due_date: null, priority_name: null, size_name: null, project_name: null, estimated_hours: null,
		source_message_ids: ["m1"], relevant_attachment_ids: [], evidence: "The map is ready.",
		proposed_action: "create", content_intent: "none", metadata_change_fields: [],
	};
	globalThis.fetch = async (_url, init) => {
		request = JSON.parse(init.body);
		return Response.json({ choices: [{ message: { content: JSON.stringify({ proposals: [{ pending_proposal_id: null, candidate }], superseded_pending_proposal_ids: [] }) } }] });
	};
	try {
		await new AzureTaskExtractor(config, async () => "token").reconcileProposals(
			[{ id: "m1", authorAlias: "USER_1", text: "Publish the map", timestamp: "2026-07-20T00:00:00Z", contextRole: "primary" }],
			[candidate],
			Array.from({ length: 30 }, (_, index) => ({ id: `p${index}`, title: `Proposal ${index}`, description: "x".repeat(4000), action: "create", sourceMessageIds: [`old${index}`] })),
		);
		const payload = JSON.parse(request.messages[1].content);
		assert.equal(payload.pendingProposals.length, 20);
		assert.ok(JSON.stringify(payload.pendingProposals).length < 18_000);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("automatic eligibility requires every precision check and safe context", () => {
	const eligible = {
		candidate_index: 0, has_activated_specific_work: true, has_remaining_work_or_trackable_transition: true,
		is_durable: true, is_decision_ready: true, sensitivity: "safe", supporting_source_message_ids: ["m1"],
	};
	assert.equal(automaticCandidateEligible(eligible), true);
	assert.equal(automaticCandidateEligible({ ...eligible, is_decision_ready: false }), false);
	assert.equal(automaticCandidateEligible({ ...eligible, sensitivity: "uncertain" }), false);
	assert.equal(automaticCandidateEligible(undefined), false);
});

test("related corrections with one work item key are merged", () => {
	const base = {
		work_item_key: "sponsorship-page", description: "Fix grouping", assignee_alias: null,
		start_date: null, due_date: null, priority_name: null, size_name: null, estimated_hours: null,
		source_message_ids: ["m1"], relevant_attachment_ids: [], evidence: "Grouping is wrong",
		proposed_action: "update", content_intent: "update_note", metadata_change_fields: [],
	};
	const merged = mergeRelatedTaskCandidates([
		{ ...base, title: "Fix page grouping" },
		{ ...base, title: "Align left-column labels", description: "Fix label alignment", source_message_ids: ["m2"] },
	]);
	assert.equal(merged.length, 1);
	assert.match(merged[0].title, /Align left-column labels/);
	assert.deepEqual(merged[0].source_message_ids, ["m1", "m2"]);
	assert.equal(mergeRelatedTaskCandidates([
		{ ...base, title: "First correction" },
		{ ...base, title: "Second correction" },
	]).length, 1);
	assert.equal(mergeRelatedTaskCandidates([
		{ ...base, title: "Comment", content_intent: "update_note" },
		{ ...base, title: "Replacement", content_intent: "replace_description" },
	]).length, 2);
	assert.equal(mergeRelatedTaskCandidates([
		{ ...base, title: "Old subject", metadata_change_fields: ["subject"] },
		{ ...base, title: "New subject", metadata_change_fields: ["subject"] },
	]).length, 2);
});

test("automatic precision gate judges raw evidence and validates complete candidate coverage", async () => {
	const originalFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (_url, init) => {
		request = JSON.parse(init.body);
		return new Response(JSON.stringify({
			choices: [{ message: { content: JSON.stringify({ window_sensitivity: "safe", assessments: [{
				candidate_index: 0,
				has_activated_specific_work: true,
				has_remaining_work_or_trackable_transition: true,
				is_durable: true,
				is_decision_ready: false,
				sensitivity: "safe",
				supporting_source_message_ids: ["m1"],
			}] }) } }],
			usage: { total_tokens: 42 },
		}), { status: 200 });
	};
	try {
		const candidate = {
			title: "Publish the ready reel", work_item_key: "instagram-reel", description: "Publish it", assignee_alias: null,
			start_date: null, due_date: null, priority_name: null, size_name: null, estimated_hours: null,
			source_message_ids: ["m1"], relevant_attachment_ids: [], evidence: "asks how publishing works",
			proposed_action: "create", content_intent: "none", metadata_change_fields: [],
		};
		const gate = await new AzureTaskExtractor(config, async () => "token").assessAutomaticCandidates([
			{ id: "m1", authorAlias: "USER_1", text: "I have a reel ready. How does Instagram access work?", timestamp: "2026-07-13T00:00:00Z", contextRole: "primary" },
		], [candidate]);
		assert.equal(automaticCandidateEligible(gate.assessments[0]), false);
		assert.equal(gate.windowSensitivity, "safe");
		assert.equal(gate.usage.totalTokens, 42);
		assert.equal(request.response_format.json_schema.name, "discord_automatic_precision_gate_v1");
		assert.match(request.messages[0].content, /untrusted hypothesis/);
		assert.match(request.messages[0].content, /How does Instagram access work/);
		assert.match(request.messages[0].content, /already present in a tracker is not activation/);
		assert.match(request.messages[0].content, /status restatement/);
		assert.match(request.messages[0].content, /Choosing a meeting time/);
		assert.match(request.messages[0].content, /Short duration alone/);
		assert.match(request.messages[0].content, /Do not require implementation details/);
		assert.match(request.messages[0].content, /merely sharing the artifact is not/);
		assert.match(request.messages[0].content, /Accepted review feedback/);
		assert.match(request.messages[0].content, /reply chain/);
		assert.match(request.messages[0].content, /focal rationale/);
		assert.match(request.messages[0].content, /follow-up email/);
		const input = JSON.parse(request.messages[1].content[0].text);
		assert.equal(input.messages[0].text.includes("How does Instagram access work"), true);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("RAG reranker assesses every retrieved candidate with structured output", async () => {
	const originalFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (_url, init) => {
		request = JSON.parse(init.body);
		return Response.json({
			choices: [{ message: { content: JSON.stringify({ assessments: [
				{ candidate_index: 0, relationship: "same_work", confidence: 0.93, reason: "Same deliverable" },
				{ candidate_index: 1, relationship: "related", confidence: 0.81, reason: "Shared campaign only" },
			] }) } }],
			usage: { total_tokens: 37 },
		});
	};
	try {
		const result = await new AzureTaskExtractor(config, async () => "token").assessRagCandidates(
			{ title: "Publish sponsor prospectus", description: "Finalize and publish the prospectus." },
			[
				{ workPackageId: 1, subject: "Sponsor prospectus", description: "Prepare the prospectus", retrievalScore: 0.74 },
				{ workPackageId: 2, subject: "Sponsor outreach", description: "Contact sponsors", retrievalScore: 0.68 },
			],
		);
		assert.deepEqual(result.assessments.map(item => item.relationship), ["same_work", "related"]);
		assert.equal(result.usage.totalTokens, 37);
		assert.equal(request.response_format.json_schema.name, "openproject_rag_rerank_v1");
		assert.match(request.messages[0].content, /untrusted data/);
		assert.equal(JSON.parse(request.messages[1].content).candidates.length, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Azure extractor sends image attachments as multimodal inputs", async () => {
	const originalFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, init) => {
		request = { url: String(url), body: JSON.parse(init.body) };
		return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tasks: [], ambiguities: [] }) } }] }), { status: 200 });
	};
	try {
		await new AzureTaskExtractor({ ...config, OPENPROJECT_AI_MAX_IMAGE_ATTACHMENTS: 8 }, async () => "token").extract([{
			id: "m1", authorAlias: "USER_1", text: "Review this screenshot", timestamp: "2026-07-13T00:00:00Z", contextRole: "primary",
			attachments: [{ id: "a1", name: "schema.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/1/2/schema.png" }],
		}]);
		assert.equal(request.body.messages[1].content[1].text, "Attachment a1: schema.png");
		assert.equal(request.body.messages[1].content[2].type, "image_url");
		assert.equal(request.body.messages[1].content[2].image_url.detail, "high");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Azure extractor retries malformed structured output only once", async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		const content = calls === 1 ? "not-json" : JSON.stringify({ tasks: [], ambiguities: [] });
		return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
	};
	try {
		await new AzureTaskExtractor(config, async () => "managed-identity-token").extract([
			{ id: "m1", authorAlias: "USER_1", text: "Ship it", timestamp: "2026-07-13T00:00:00Z" },
		]);
		assert.equal(calls, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Azure extractor retries truncated structured output with the full token budget", async () => {
	const originalFetch = globalThis.fetch;
	const budgets = [];
	globalThis.fetch = async (_url, init) => {
		const request = JSON.parse(init.body);
		budgets.push(request.max_completion_tokens);
		const truncated = budgets.length === 1;
		return new Response(JSON.stringify({
			choices: [{ finish_reason: truncated ? "length" : "stop", message: { content: truncated ? '{"tasks":[' : JSON.stringify({ tasks: [], ambiguities: [] }) } }],
			usage: { completion_tokens: truncated ? 1024 : 20 },
		}), { status: 200 });
	};
	try {
		await new AzureTaskExtractor(config, async () => "managed-identity-token").extract([
			{ id: "m1", authorAlias: "USER_1", text: "Ship it", timestamp: "2026-07-13T00:00:00Z" },
		]);
		assert.deepEqual(budgets, [1024, 4096]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Azure image limit applies globally across all messages", async () => {
	const originalFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (_url, init) => {
		request = JSON.parse(init.body);
		return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tasks: [], ambiguities: [] }) } }] }), { status: 200 });
	};
	try {
		await new AzureTaskExtractor({ ...config, OPENPROJECT_AI_MAX_IMAGE_ATTACHMENTS: 1 }, async () => "token").extract([
			{ id: "m1", authorAlias: "USER_1", text: "First", timestamp: "2026-07-13T00:00:00Z", priority: true, attachments: [{ id: "a1", name: "one.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/1/2/one.png" }] },
			{ id: "m2", authorAlias: "USER_2", text: "Second", timestamp: "2026-07-13T00:01:00Z", attachments: [{ id: "a2", name: "two.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/1/2/two.png" }] },
		]);
		assert.equal(request.messages[1].content.filter(part => part.type === "image_url").length, 1);
		assert.equal(request.messages[1].content.filter(part => part.type === "text" && part.text.startsWith("Attachment ")).length, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a safely redacted credential marker does not block deterministic minimization", () => {
	const text = minimizeText("token=do-not-send-to-cloud");
	assert.equal(containsSensitiveContent([
		{ id: "m1", authorAlias: "USER_1", text, timestamp: "2026-07-13T00:00:00Z" },
	]), false);
});

test("schema vocabulary, Prisms discussion, Notion links, and account access prose are safe", () => {
	const text = [
		"The Prisms schema has credential, password: string, api_key: z.string(), access_token, application_id, account, and private fields.",
		"Document the account access flow at https://www.notion.so/example and explain Authorization Bearer values without including one.",
	].join("\n");
	assert.equal(minimizeText(text), text);
	assert.equal(containsSensitiveContent([{ id: "m1", authorAlias: "USER_1", text, timestamp: "2026-07-13T00:00:00Z" }]), false);
});

test("actual assignments, bearer values, JWTs, and PEM private keys are redacted", () => {
	const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345678";
	const pem = "-----BEGIN PRIVATE KEY-----\nactual-private-key-material\n-----END PRIVATE KEY-----";
	const text = minimizeText(`password=hunter2\napi_key: sk-live-secret\nAuthorization: Bearer bearer-secret\n${jwt}\n${pem}`);
	for (const secret of ["hunter2", "sk-live-secret", "bearer-secret", jwt, "actual-private-key-material"]) {
		assert.equal(text.includes(secret), false);
	}
	assert.equal((text.match(/\[REDACTED_CREDENTIAL\]/g) ?? []).length, 5);
	assert.equal(containsSensitiveContent([{ id: "m1", authorAlias: "USER_1", text, timestamp: "2026-07-13T00:00:00Z", containedSensitiveData: true }]), false);
});

test("natural-language credential assignments and encrypted private keys are redacted", () => {
	const text = minimizeText("password is hunter2\n-----BEGIN ENCRYPTED PRIVATE KEY-----\nprivate-material\n-----END ENCRYPTED PRIVATE KEY-----");
	assert.equal(text.includes("hunter2"), false);
	assert.equal(text.includes("private-material"), false);
	assert.equal((text.match(/\[REDACTED_CREDENTIAL\]/g) ?? []).length, 2);
});

test("conversational username and password values are redacted", () => {
	const input = "Log in with username logistics1 and password letava to view the orders.";
	const minimized = minimizeText(input);
	assert.equal(minimized.includes("logistics1"), false);
	assert.equal(minimized.includes("letava"), false);
	assert.match(minimized, /username \[REDACTED_CREDENTIAL\].*password \[REDACTED_CREDENTIAL\]/);
	for (const assignment of ["password was hunter2", "password should be hunter2", "username is alice", "username: alice"]) {
		assert.equal(minimizeText(assignment).includes(assignment.split(/\s|: /).at(-1)), false);
	}
	for (const pair of ["username alice and password is hunter2", "username alice and password: hunter2", "username alice and password correct horse battery staple"]) {
		const minimizedPair = minimizeText(pair);
		assert.equal(minimizedPair.includes("alice"), false);
		assert.equal(minimizedPair.includes("hunter2"), false);
		assert.equal(minimizedPair.includes("correct horse"), false);
	}
	const ordinary = "Plan the password reset, username field, API key rotation, and client secret management.";
	assert.equal(minimizeText(ordinary), ordinary);
	assert.equal(minimizeText("The password is stored in Key Vault."), "The password is stored in Key Vault.");
	assert.equal(minimizeText("Use password authentication to access staging."), "Use password authentication to access staging.");
	assert.equal(minimizeText("Use the service using password correct horse battery staple."), "Use the service using password [REDACTED_CREDENTIAL]");
});

test("Azure bounds before sensitivity decisions and sends only redacted values", async () => {
	const originalFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (_url, init) => {
		request = JSON.parse(init.body);
		return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tasks: [], ambiguities: [] }) } }] }), { status: 200 });
	};
	try {
		const extractor = new AzureTaskExtractor({ ...config, OPENPROJECT_AI_MAX_CONTEXT_CHARS: 2000 }, async () => "token");
		await extractor.extract([
			{ id: "excluded", authorAlias: "USER_2", text: `payroll ${"x".repeat(3000)}`, timestamp: "2026-07-13T00:00:00Z", contextRole: "preceding" },
			{ id: "primary", authorAlias: "USER_1", text: `password=hunter2 Ship the schema notes ${"y".repeat(1850)}`, timestamp: "2026-07-13T00:01:00Z", contextRole: "primary", containedSensitiveData: true },
		]);
		const payload = request.messages[1].content[0].text;
		assert.match(payload, /\[REDACTED_CREDENTIAL\]/);
		assert.equal(payload.includes("hunter2"), false);
		assert.equal(payload.includes("payroll"), false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("manual override never restores detected secret values", async () => {
	const originalFetch = globalThis.fetch;
	let payload = "";
	globalThis.fetch = async (_url, init) => {
		payload = JSON.parse(init.body).messages[1].content[0].text;
		return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tasks: [], ambiguities: [] }) } }] }), { status: 200 });
	};
	try {
		await new AzureTaskExtractor(config, async () => "token").extract([
			{ id: "m1", authorAlias: "USER_1", text: "access_token=never-send-this", timestamp: "2026-07-13T00:00:00Z" },
		], { allowSensitiveContent: true });
		assert.match(payload, /\[REDACTED_CREDENTIAL\]/);
		assert.equal(payload.includes("never-send-this"), false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("contextual sensitivity is delegated to the structured model assessment", () => {
	const contextual = [{ id: "m1", authorAlias: "USER_1", text: "Please send the payroll spreadsheet", timestamp: "2026-07-13T00:00:00Z" }];
	assert.equal(containsSensitiveContent(contextual), false);
	assert.deepEqual(sensitiveContentReasons(contextual), []);
});

test("unsafe unredacted secret preclassification still blocks locally without exposing values", () => {
	assert.deepEqual(sensitiveContentReasons([
		{ id: "m1", authorAlias: "USER_1", text: "opaque content", timestamp: "2026-07-13T00:00:00Z", containedSensitiveData: true, redactionStatus: "unsafe" },
	]), ["Content pre-classified as sensitive before minimization"]);
});

test("email addresses are redacted without blocking AI review", () => {
	const text = minimizeText("Contact organizer@example.com for the venue quote.");
	assert.match(text, /\[REDACTED_EMAIL\]/);
	assert.equal(containsSensitiveContent([{ id: "m1", authorAlias: "USER_1", text, timestamp: "2026-07-13T00:00:00Z" }]), false);
});

test("ordinary organizer agreements and board work are not treated as sensitive", () => {
	assert.equal(containsSensitiveContent([
		{ id: "m1", authorAlias: "USER_1", text: "Review the sponsorship agreement, invoice, contract negotiation notes, and board meeting agenda.", timestamp: "2026-07-13T00:00:00Z" },
	]), false);
	assert.equal(minimizeText("Keep the sponsor reveal secret until launch."), "Keep the sponsor reveal secret until launch.");
});

test("a manual override permits one explicitly approved locally blocked request", async () => {
	const sensitive = [{ id: "m1", authorAlias: "USER_1", text: "opaque content", timestamp: "2026-07-13T00:00:00Z", containedSensitiveData: true, redactionStatus: "unsafe" }];
	let requested = false;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		requested = true;
		return new Response(JSON.stringify({
			choices: [{ message: { content: JSON.stringify({ tasks: [], ambiguities: [] }) } }],
		}), { status: 200 });
	};
	try {
		const extraction = await new AzureTaskExtractor(config, async () => "managed-identity-token").extract(
			sensitive,
			{ allowSensitiveContent: true },
		);
		assert.equal(requested, true);
		assert.deepEqual(extraction.replayOptions, { allowSensitiveContent: true });
	} finally {
		globalThis.fetch = originalFetch;
	}
});
