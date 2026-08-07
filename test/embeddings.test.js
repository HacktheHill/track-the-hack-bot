import assert from "node:assert/strict";
import test from "node:test";
import { AzureEmbeddingClient } from "../dist/embeddings.js";

const config = {
	AZURE_OPENAI_ENDPOINT: "https://azure.example",
	AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "embedding-model",
	AZURE_OPENAI_EMBEDDING_DIMENSIONS: 2,
	AZURE_OPENAI_API_VERSION: "v1",
};

function successResponse() {
	return Response.json({ data: [{ index: 0, embedding: [0.25, 0.75] }], model: "embedding-model" });
}

test("embedding retries requested HTTP statuses, honors delay headers, and cancels retry bodies", async () => {
	const originalFetch = globalThis.fetch;
	const statuses = [429, 500, 502, 503, 504];
	const delays = [];
	let calls = 0;
	let cancellations = 0;
	globalThis.fetch = async () => {
		const request = calls++;
		if (request % 2 === 1) return successResponse();
		const index = request / 2;
		const status = statuses[index];
		const body = new ReadableStream({ cancel() { cancellations++; } });
		const headers = index === 0 ? { "retry-after-ms": "11", "x-ms-retry-after-ms": "12", "retry-after": "13" }
			: index === 1 ? { "x-ms-retry-after-ms": "12", "retry-after": "13" }
				: { "retry-after": "0" };
		return new Response(body, { status, headers });
	};
	try {
		const client = new AzureEmbeddingClient(config, async () => "token", async delay => { delays.push(delay); });
		for (const status of statuses) {
			const result = await client.embed([`status ${status}`]);
			assert.deepEqual(result.embeddings, [[0.25, 0.75]]);
		}
		assert.deepEqual(delays, [11, 12, 0, 0, 0]);
		assert.equal(cancellations, statuses.length);
		assert.equal(calls, statuses.length * 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("embedding retries transient network errors", async () => {
	const originalFetch = globalThis.fetch;
	const delays = [];
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		if (calls === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
		return successResponse();
	};
	try {
		const result = await new AzureEmbeddingClient(config, async () => "token", async delay => { delays.push(delay); }).embed(["example"]);
		assert.deepEqual(result.embeddings, [[0.25, 0.75]]);
		assert.deepEqual(delays, [1000]);
		assert.equal(calls, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("embedding returns the final retryable response without sleeping or cancelling it", async () => {
	const originalFetch = globalThis.fetch;
	const delays = [];
	let calls = 0;
	let cancellations = 0;
	globalThis.fetch = async () => {
		calls++;
		const body = calls === 5
			? JSON.stringify({ error: "still unavailable" })
			: new ReadableStream({ cancel() { cancellations++; } });
		return new Response(body, { status: 503, headers: { "retry-after-ms": "0" } });
	};
	try {
		const client = new AzureEmbeddingClient(config, async () => "token", async delay => { delays.push(delay); });
		await assert.rejects(client.embed(["example"]), /Azure embeddings 503/);
		assert.equal(calls, 5);
		assert.equal(cancellations, 4);
		assert.deepEqual(delays, [0, 0, 0, 0]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("embedding does not retry non-transient failures", async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		throw new Error("invalid request setup");
	};
	try {
		await assert.rejects(new AzureEmbeddingClient(config, async () => "token", async () => {}).embed(["example"]), /invalid request setup/);
		assert.equal(calls, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
