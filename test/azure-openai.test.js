import assert from "node:assert/strict";
import test from "node:test";
import { automaticCandidateEligible, AzureTaskExtractor, containsSensitiveContent, extractionDiagnostics, minimizeText, normalizeExtractedDate, sensitiveContentReasons, SensitiveContentError } from "../dist/azure-openai.js";

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

const config = {
	AZURE_OPENAI_MAX_COMPLETION_TOKENS: 1024,
	OPENPROJECT_AI_MAX_CONTEXT_CHARS: 16000,
	AZURE_OPENAI_ENDPOINT: "https://azure.example",
	AZURE_OPENAI_DEPLOYMENT: "task-extractor",
	AZURE_OPENAI_API_VERSION: "v1",
};

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
			{ mode: "manual", metadata: { priorities: ["High"], sizes: ["Small"] } },
		);
		assert.equal(request.url, "https://azure.example/openai/v1/chat/completions");
		assert.equal(request.body.model, "task-extractor");
		assert.equal(request.body.max_completion_tokens, 1024);
		assert.equal("max_tokens" in request.body, false);
		assert.equal("temperature" in request.body, false);
		assert.equal(request.headers.Authorization, "Bearer managed-identity-token");
		assert.match(request.body.messages[0].content, /Manual extraction is intentionally broad/);
		assert.match(request.body.messages[0].content, /invoking it supplies human intent/);
		assert.match(request.body.messages[0].content, /automatic_eligibility=eligible/);
		assert.match(request.body.messages[0].content, /transient synchronous help/);
		assert.match(request.body.messages[0].content, /live access codes, login assistance/);
		assert.match(request.body.messages[0].content, /Group requirements and feedback/);
		assert.match(request.body.messages[0].content, /proposed_action=update for requests to review or revise/);
		assert.match(request.body.messages[0].content, /do not split another defect/);
		assert.match(request.body.messages[0].content, /timestamps/);
		assert.match(request.body.messages[0].content, /priority_name must exactly match one of: High/);
		assert.match(request.body.messages[0].content, /size_name must exactly match one of: Small/);
		assert.match(request.body.messages[0].content, /content_intent=update_note/);
		assert.match(request.body.messages[0].content, /only explicitly requested existing-task metadata changes/);
		assert.match(request.body.messages[0].content, /do not invent missing objectives/i);
		assert.match(request.body.messages[0].content, /heading and bullet list/);
		assert.match(request.body.messages[0].content, /application adds verified links separately/);
		assert.match(request.body.messages[0].content, /Human review decides whether to accept it/);
		assert.ok(request.body.response_format.json_schema.schema.properties.tasks.items.required.includes("content_intent"));
		assert.ok(request.body.response_format.json_schema.schema.properties.tasks.items.required.includes("automatic_eligibility"));
		assert.ok(request.body.response_format.json_schema.schema.properties.tasks.items.required.includes("trigger_kind"));
		assert.ok(request.body.response_format.json_schema.schema.properties.tasks.items.required.includes("lifecycle"));
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
		assert.deepEqual(extraction.metadata, { priorities: ["High"], sizes: ["Small"] });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("automatic eligibility is an explicit runtime gate", () => {
	assert.equal(automaticCandidateEligible({ automatic_eligibility: "eligible" }), true);
	assert.equal(automaticCandidateEligible({ automatic_eligibility: "ineligible" }), false);
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

test("a redaction marker remains sensitive after deterministic minimization", () => {
	const text = minimizeText("token=do-not-send-to-cloud");
	assert.equal(containsSensitiveContent([
		{ id: "m1", authorAlias: "USER_1", text, timestamp: "2026-07-13T00:00:00Z" },
	]), true);
});

test("sensitive content is rejected before an Azure request", async () => {
	const sensitive = [{ id: "m1", authorAlias: "USER_1", text: "Please send the payroll spreadsheet", timestamp: "2026-07-13T00:00:00Z" }];
	assert.equal(containsSensitiveContent(sensitive), true);
	let requested = false;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		requested = true;
		throw new Error("should not be called");
	};
	try {
		let rejected;
		await assert.rejects(new AzureTaskExtractor(config, async () => "managed-identity-token").extract(sensitive), error => {
			rejected = error;
			return error instanceof SensitiveContentError;
		});
		assert.deepEqual(extractionDiagnostics(rejected)?.inputMessages, sensitive);
		assert.deepEqual(extractionDiagnostics(rejected)?.replayOptions, { allowSensitiveContent: false });
		assert.equal(requested, false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("sensitive-content decisions expose safe categories without matched values", () => {
	assert.deepEqual(sensitiveContentReasons([
		{ id: "m1", authorAlias: "USER_1", text: "Please send the payroll spreadsheet", timestamp: "2026-07-13T00:00:00Z" },
	]), ["Financial, payroll, or payment information"]);
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

test("a manual override permits one explicitly approved sensitive request", async () => {
	const sensitive = [{ id: "m1", authorAlias: "USER_1", text: "Please send the payroll spreadsheet", timestamp: "2026-07-13T00:00:00Z" }];
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
