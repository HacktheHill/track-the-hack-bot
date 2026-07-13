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
	LOCAL_MODEL_TIMEOUT_MS: 1000,
	AZURE_OPENAI_ENDPOINT: "https://azure.example",
	AZURE_OPENAI_NANO_DEPLOYMENT: "nano",
	AZURE_OPENAI_MINI_DEPLOYMENT: undefined,
	AZURE_OPENAI_API_VERSION: "v1",
	OPENPROJECT_AI_ESCALATION_MODE: "ambiguous",
};

test("local extractor uses the private OpenAI-compatible endpoint", async () => {
	const originalFetch = globalThis.fetch;
	let request;
	globalThis.fetch = async (url, init) => {
		request = { url: String(url), body: JSON.parse(init.body) };
		return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "", tasks: [], ambiguities: [] }) } }] }), { status: 200 });
	};
	try {
		const extractor = new LocalTaskExtractor(config);
		await extractor.extract([{ id: "m1", authorAlias: "USER_1", text: "Ship it", timestamp: "2026-07-13T00:00:00Z" }]);
		assert.equal(request.url, "http://10.0.0.4:8090/v1/chat/completions");
		assert.equal(request.body.model, "qwen3-4b-q4_k_m");
	} finally {
		globalThis.fetch = originalFetch;
	}
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
