import assert from "node:assert/strict";
import test from "node:test";
import { AzureTaskExtractor, containsSensitiveContent, minimizeText, normalizeExtractedDate, SensitiveContentError } from "../dist/azure-openai.js";

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
		return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "", tasks: [], ambiguities: [] }) } }] }), { status: 200 });
	};
	try {
		const extractor = new AzureTaskExtractor(config, async () => "managed-identity-token");
		await extractor.extract(
			[{ id: "m1", authorAlias: "USER_1", text: "Ship it", timestamp: "2026-07-13T00:00:00Z", contextRole: "primary" }],
			{ metadata: { priorities: ["High"], sizes: ["Small"] } },
		);
		assert.equal(request.url, "https://azure.example/openai/v1/chat/completions");
		assert.equal(request.body.model, "task-extractor");
		assert.equal(request.body.max_completion_tokens, 1024);
		assert.equal("max_tokens" in request.body, false);
		assert.equal("temperature" in request.body, false);
		assert.equal(request.headers.Authorization, "Bearer managed-identity-token");
		assert.match(request.body.messages[0].content, /one or more messages have contextRole=primary/);
		assert.match(request.body.messages[0].content, /Evaluate each primary message independently/);
		assert.match(request.body.messages[0].content, /timestamps/);
		assert.match(request.body.messages[0].content, /priority_name must exactly match one of: High/);
		assert.match(request.body.messages[0].content, /size_name must exactly match one of: Small/);
		assert.deepEqual(JSON.parse(request.body.messages[1].content[0].text)[0], {
			id: "m1", authorAlias: "USER_1", text: "Ship it",
			timestamp: "2026-07-13T00:00:00Z", contextRole: "primary",
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Azure extractor sends image attachments as multimodal inputs", async () => {
	const originalFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, init) => {
		request = { url: String(url), body: JSON.parse(init.body) };
		return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "", tasks: [], ambiguities: [] }) } }] }), { status: 200 });
	};
	try {
		await new AzureTaskExtractor({ ...config, OPENPROJECT_AI_MAX_IMAGE_ATTACHMENTS: 8 }, async () => "token").extract([{
			id: "m1", authorAlias: "USER_1", text: "Review this screenshot", timestamp: "2026-07-13T00:00:00Z", contextRole: "primary",
			attachments: [{ id: "a1", name: "schema.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/1/2/schema.png" }],
		}]);
		assert.equal(request.body.messages[1].content[1].type, "image_url");
		assert.equal(request.body.messages[1].content[1].image_url.detail, "high");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Azure extractor retries malformed structured output only once", async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		const content = calls === 1 ? "not-json" : JSON.stringify({ summary: "", tasks: [], ambiguities: [] });
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
			choices: [{ finish_reason: truncated ? "length" : "stop", message: { content: truncated ? '{"summary":"' : JSON.stringify({ summary: "", tasks: [], ambiguities: [] }) } }],
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

test("Azure extraction returns one assessment for every supplied message", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "", message_assessments: [{ message_id: "m1", relevance: "relevant", significance_score: 0.8, rationale: "assignment" }], tasks: [], ambiguities: [] }) } }] }), { status: 200 });
	try {
		const result = await new AzureTaskExtractor(config, async () => "token").extract([
			{ id: "m1", authorAlias: "USER_1", text: "Ship it", timestamp: "2026-07-13T00:00:00Z" },
			{ id: "m2", authorAlias: "USER_2", text: "Unrelated", timestamp: "2026-07-13T00:01:00Z" },
		]);
		assert.deepEqual(result.result.message_assessments.map(item => item.message_id), ["m1", "m2"]);
		assert.equal(result.result.message_assessments[1].relevance, "unclear");
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
		await assert.rejects(
			new AzureTaskExtractor(config, async () => "managed-identity-token").extract(sensitive),
			SensitiveContentError,
		);
		assert.equal(requested, false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a manual override permits one explicitly approved sensitive request", async () => {
	const sensitive = [{ id: "m1", authorAlias: "USER_1", text: "Please send the payroll spreadsheet", timestamp: "2026-07-13T00:00:00Z" }];
	let requested = false;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		requested = true;
		return new Response(JSON.stringify({
			choices: [{ message: { content: JSON.stringify({ summary: "", tasks: [], ambiguities: [] }) } }],
		}), { status: 200 });
	};
	try {
		await new AzureTaskExtractor(config, async () => "managed-identity-token").extract(
			sensitive,
			{ allowSensitiveContent: true },
		);
		assert.equal(requested, true);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
