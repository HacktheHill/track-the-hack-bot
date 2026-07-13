import assert from "node:assert/strict";
import test from "node:test";
import { containsSensitiveContent, LocalTaskExtractor, minimizeText, shouldEscalateToAzure } from "../dist/azure-openai.js";

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

const config = {
	LOCAL_MODEL_ENDPOINT: "http://10.0.0.4:8090/v1",
	LOCAL_MODEL_NAME: "qwen3-4b-q4_k_m",
	LOCAL_MODEL_API_KEY: "a-local-model-secret-token",
	LOCAL_MODEL_TIMEOUT_MS: 1000,
	LOCAL_MODEL_MAX_TOKENS: 384,
	OPENPROJECT_AI_MAX_CONTEXT_CHARS: 16000,
	AZURE_OPENAI_ENDPOINT: "https://azure.example",
	AZURE_OPENAI_NANO_DEPLOYMENT: "nano",
	AZURE_OPENAI_MINI_DEPLOYMENT: undefined,
	AZURE_OPENAI_API_VERSION: "v1",
	OPENPROJECT_AI_ESCALATION_MODE: "ambiguous",
};

test("local extractor authenticates, bounds output, and uses the private endpoint", async () => {
	const originalFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, init) => {
		request = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
		return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "", tasks: [], ambiguities: [] }) } }] }), { status: 200 });
	};
	try {
		const extractor = new LocalTaskExtractor(config);
		await extractor.extract([{ id: "m1", authorAlias: "USER_1", text: "Ship it", timestamp: "2026-07-13T00:00:00Z" }]);
		assert.equal(request.url, "http://10.0.0.4:8090/v1/chat/completions");
		assert.equal(request.body.model, "qwen3-4b-q4_k_m");
		assert.equal(request.body.max_tokens, 384);
		assert.equal(request.headers.Authorization, "Bearer a-local-model-secret-token");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("local extractor retries malformed structured output only once", async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		const content = calls === 1 ? "not-json" : JSON.stringify({ summary: "", tasks: [], ambiguities: [] });
		return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
	};
	try {
		await new LocalTaskExtractor(config).extract([
			{ id: "m1", authorAlias: "USER_1", text: "Ship it", timestamp: "2026-07-13T00:00:00Z" },
		]);
		assert.equal(calls, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a redaction marker remains sensitive after deterministic minimization", () => {
	const text = minimizeText("token=do-not-send-to-cloud");
	assert.equal(containsSensitiveContent([
		{ id: "m1", authorAlias: "USER_1", text, timestamp: "2026-07-13T00:00:00Z" },
	]), true);
	assert.equal(shouldEscalateToAzure([
		{ id: "m1", authorAlias: "USER_1", text, timestamp: "2026-07-13T00:00:00Z" },
	], config, false), false);
});

test("sensitive content never qualifies for Azure escalation", () => {
	const sensitive = [{ id: "m1", authorAlias: "USER_1", text: "Please send the payroll spreadsheet", timestamp: "2026-07-13T00:00:00Z" }];
	assert.equal(containsSensitiveContent(sensitive), true);
	assert.equal(shouldEscalateToAzure(sensitive, config, false), false);
});

test("ordinary ambiguous content may qualify for Azure escalation", () => {
	const ordinary = [{ id: "m1", authorAlias: "USER_1", text: "Should we ship the portal Friday or Monday?", timestamp: "2026-07-13T00:00:00Z" }];
	assert.equal(shouldEscalateToAzure(ordinary, config, false), true);
});
