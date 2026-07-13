import assert from "node:assert/strict";
import test from "node:test";
import { AzureTaskExtractor, containsSensitiveContent, minimizeText, SensitiveContentError } from "../dist/azure-openai.js";

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
		await extractor.extract([{ id: "m1", authorAlias: "USER_1", text: "Ship it", timestamp: "2026-07-13T00:00:00Z" }]);
		assert.equal(request.url, "https://azure.example/openai/v1/chat/completions");
		assert.equal(request.body.model, "task-extractor");
		assert.equal(request.body.max_completion_tokens, 1024);
		assert.equal("max_tokens" in request.body, false);
		assert.equal("temperature" in request.body, false);
		assert.equal(request.headers.Authorization, "Bearer managed-identity-token");
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
