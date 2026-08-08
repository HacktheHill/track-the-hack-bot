import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertAggregateBakeoffReport,
	BAKEOFF_VERSION,
	bakeoffCacheKey,
	canonicalOnePassPrediction,
	runBakeoff,
	validBakeoffCacheEntry,
	withBakeoffOuterRetries,
} from "../dist/ai-bakeoff.js";
import { AzureOnePassEvaluator, AzureTaskExtractor, StructuredOutputError } from "../dist/azure-openai.js";
import { parseBakeoffBlobArguments } from "../dist/evaluate-ai-bakeoff-blob.js";
import { exactProposalMatchCount } from "../dist/evaluate-ai.js";

const env = {
	AZURE_OPENAI_ENDPOINT: "https://azure.example",
	AZURE_OPENAI_DEPLOYMENT: "task-extractor",
	AZURE_OPENAI_API_VERSION: "v1",
	AZURE_OPENAI_MAX_COMPLETION_TOKENS: 1024,
	AZURE_OPENAI_CHAT_MAX_CONCURRENCY: 1,
	AZURE_OPENAI_CHAT_MIN_INTERVAL_MS: 0,
	OPENPROJECT_AI_MAX_CONTEXT_CHARS: 2000,
	OPENPROJECT_AI_MAX_IMAGE_ATTACHMENTS: 2,
	AI_EVAL_MIN_INTERVAL_MS: 0,
	AI_EVAL_PROVIDER_RETRIES: 0,
	AI_EVAL_CACHE_DIR: ".private/test-cache",
	AI_EVAL_MAX_UNCACHED_CASES: 25,
	AI_EVAL_RELEASE_MIN_WINDOWS: 1,
	AI_EVAL_RELEASE_MIN_PROPOSAL_PRECISION: 0,
	AI_EVAL_RELEASE_MIN_VALID_OUTPUT_RATE: 0,
};

function sampleWindow(index = 17) {
	return {
		id: `private-case-${index}`,
		mode: "automatic",
		messages: [{
			id: `private-source-${index}`, authorAlias: "Person A", text: "api_key=do-not-send. Please publish the venue map.",
			timestamp: `2026-08-08T12:00:${String(index).padStart(2, "0")}.000Z`, contextRole: "primary",
		}],
		expected: { proposals: [{ action: "create", titleIncludes: ["venue", "map"], sourceMessageIds: [`private-source-${index}`] }] },
	};
}

function sampleTask(source = "private-source-17", overrides = {}) {
	return {
		title: "Publish venue map", work_item_key: "venue-map", description: "Publish the venue map.", assignee_alias: null,
		start_date: null, due_date: null, priority_name: null, size_name: null, project_name: null, estimated_hours: null,
		source_message_ids: [source], relevant_attachment_ids: [], evidence: "A publication request is explicit.",
		proposed_action: "create", content_intent: "none", metadata_change_fields: [], ...overrides,
	};
}

const assessment = {
	has_activated_specific_work: true,
	has_remaining_work_or_trackable_transition: true,
	is_durable: true,
	is_decision_ready: true,
	sensitivity: "safe",
	supporting_source_message_ids: ["private-source-17"],
};

const trace = {
	extractedCandidates: 1, referenceValidCandidates: 1, groundedCandidates: 1, finalCandidates: 1,
	gateCriteriaFailures: { activation: 0, remainingWork: 0, durability: 0, decisionReadiness: 0, sensitivity: 0 },
};

function provider(overrides = {}) {
	return {
		logicalCalls: 1, httpAttempts: 1, httpRetries: 0, http429s: 0, outerRetries: 0,
		reportedPromptTokens: 70, reportedCompletionTokens: 20, reportedTotalTokens: 90,
		tokenTelemetryResponses: 1, httpAttemptLatencyMs: 500, httpAttemptLatencySamples: 1, ...overrides,
	};
}

function prediction(value, metrics = provider()) {
	return { predicted: [sampleTask(value.messages[0].id)], trace, provider: metrics };
}

test("one-pass evaluation is isolated, redacted, canonical, and carries the complete automatic gate schema", async () => {
	assert.equal(typeof AzureTaskExtractor.prototype.evaluate, "undefined");
	const window = sampleWindow();
	const task = sampleTask();
	const originalFetch = globalThis.fetch;
	let request;
	const attempts = [];
	let calls = 0;
	globalThis.fetch = async (_url, init) => {
		calls++;
		request = JSON.parse(init.body);
		if (calls === 1) return Response.json({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after-ms": "0" } });
		return Response.json({
			choices: [{ message: { content: JSON.stringify({ window_sensitivity: "safe", canonical_candidates: [{ ...task, ...assessment }], ambiguities: [] }) } }],
			usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
		});
	};
	try {
		const result = await new AzureOnePassEvaluator(env, async () => "token", attempt => attempts.push(attempt)).evaluate(window.messages, { mode: "automatic" });
		assert.equal(result.result.tasks.length, 1);
		assert.equal(result.windowSensitivity, "safe");
		assert.equal(JSON.stringify(request).includes("do-not-send"), false);
		assert.equal(JSON.stringify(request).includes("REDACTED_CREDENTIAL"), true);
		assert.match(request.messages[0].content, /entire supplied window/);
		assert.match(request.messages[0].content, /already canonical/);
		assert.match(request.messages[0].content, /Never return duplicate or mergeable candidates/);
		const schema = request.response_format.json_schema.schema;
		assert.ok(schema.required.includes("window_sensitivity"));
		assert.ok(schema.required.includes("canonical_candidates"));
		for (const field of ["has_activated_specific_work", "has_remaining_work_or_trackable_transition", "is_durable", "is_decision_ready", "sensitivity", "supporting_source_message_ids"]) {
			assert.ok(schema.properties.canonical_candidates.items.required.includes(field));
		}
		assert.deepEqual(attempts.map(item => ({ status: item.status, httpRetry: item.httpRetry })), [{ status: 429, httpRetry: false }, { status: 200, httpRetry: true }]);
		assert.equal(attempts.every(item => item.latencyMs >= 0), true);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("exact proposal matching is maximum-cardinality and independent of prediction order", () => {
	const expected = [
		{ action: "create", titleIncludes: ["map"], sourceMessageIds: ["m1"] },
		{ action: "create", titleIncludes: ["venue", "map"], sourceMessageIds: ["m1"] },
	];
	const specific = sampleTask("m1", { title: "Publish venue map" });
	const broadOnly = sampleTask("m1", { title: "Publish map", description: "Publish the final artifact." });
	assert.equal(exactProposalMatchCount(expected, [specific, broadOnly]), 2);
	assert.equal(exactProposalMatchCount(expected, [broadOnly, specific]), 2);
});

test("HTTP attempt latency excludes token acquisition and wrapper latency is not required for aggregation", async () => {
	const originalFetch = globalThis.fetch;
	const attempts = [];
	globalThis.fetch = async () => Response.json({
		choices: [{ message: { content: JSON.stringify({ window_sensitivity: "safe", canonical_candidates: [], ambiguities: [] }) } }],
		usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
	});
	try {
		const started = Date.now();
		const result = await new AzureOnePassEvaluator(env, async () => {
			await new Promise(resolve => setTimeout(resolve, 35));
			return "token";
		}, attempt => attempts.push(attempt)).evaluate(sampleWindow().messages);
		const elapsed = Date.now() - started;
		assert.equal(attempts.length, 1);
		assert.ok(elapsed - attempts[0].latencyMs >= 25);
		assert.ok(elapsed - result.latencyMs >= 25);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("one-pass canonical validation precedes eligibility and rejects invalid or mergeable output", () => {
	const window = sampleWindow();
	const base = {
		windowSensitivity: "safe", deployment: "test", latencyMs: 1, inputMessages: window.messages,
		result: { tasks: [sampleTask()], ambiguities: [] },
		assessments: [{ candidate_index: 0, ...assessment }],
	};
	assert.equal(canonicalOnePassPrediction(base, window).predicted.length, 1);
	assert.equal(canonicalOnePassPrediction({ ...base, windowSensitivity: "uncertain" }, window).predicted.length, 0);
	assert.throws(() => canonicalOnePassPrediction({
		...base,
		result: { tasks: [sampleTask(), sampleTask("private-source-17", { title: "Publish final map" })], ambiguities: [] },
		assessments: [{ candidate_index: 0, ...assessment }, { candidate_index: 1, ...assessment }],
	}, window), /not canonical/);
	assert.throws(() => canonicalOnePassPrediction({
		...base, result: { tasks: [sampleTask("unknown")], ambiguities: [] },
	}, window), /reference validation/);
});

test("uncached-window limit fails before execution and the Blob CLI requires explicit --full opt-in", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ai-bakeoff-cap-"));
	let executions = 0;
	try {
		await assert.rejects(runBakeoff([sampleWindow(1), sampleWindow(2)], { ...env, AI_EVAL_MAX_UNCACHED_CASES: 1 }, {
			cacheDirectory: directory, fresh: true, executor: async (_strategy, value) => { executions++; return prediction(value); },
		}), /exceeding AI_EVAL_MAX_UNCACHED_CASES/);
		assert.equal(executions, 0);
		await runBakeoff([sampleWindow(1), sampleWindow(2)], { ...env, AI_EVAL_MAX_UNCACHED_CASES: 1 }, {
			cacheDirectory: directory, fresh: true, full: true, executor: async (_strategy, value) => { executions++; return prediction(value); },
		});
		assert.equal(executions, 4);
		assert.deepEqual(parseBakeoffBlobArguments([]), { full: false });
		assert.deepEqual(parseBakeoffBlobArguments(["--full"]), { full: true });
		assert.throws(() => parseBakeoffBlobArguments(["--force"]), /Usage/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("successful uncached evaluations alternate arm order and honor evaluation pacing", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ai-bakeoff-order-"));
	const starts = [];
	try {
		await runBakeoff([sampleWindow(1), sampleWindow(2)], { ...env, AI_EVAL_MIN_INTERVAL_MS: 15 }, {
			cacheDirectory: directory, fresh: true, full: true,
			executor: async (strategy, value, _config, beforeAdditionalCall) => {
				starts.push({ event: `${value.id}:${strategy}`, at: Date.now() });
				if (strategy === "two_stage") {
					await beforeAdditionalCall();
					starts.push({ event: `${value.id}:gate`, at: Date.now() });
				}
				return prediction(value);
			},
		});
		assert.deepEqual(starts.map(item => item.event), [
			"private-case-1:two_stage", "private-case-1:gate", "private-case-1:one_pass",
			"private-case-2:one_pass", "private-case-2:two_stage", "private-case-2:gate",
		]);
		for (let index = 1; index < starts.length; index++) assert.ok(starts[index].at - starts[index - 1].at >= 10);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("historical cost stays separate from partial-cache current runtime and incomplete tokens are lower bounds", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ai-bakeoff-cache-"));
	const window = sampleWindow();
	try {
		await runBakeoff([window], env, {
			cacheDirectory: directory, fresh: true,
			executor: async (strategy, value) => prediction(value, strategy === "two_stage"
				? provider({ logicalCalls: 2, httpAttempts: 3, httpRetries: 1, http429s: 1, reportedTotalTokens: 125, tokenTelemetryResponses: 2, httpAttemptLatencyMs: 900, httpAttemptLatencySamples: 3 })
				: provider()),
		});
		await rm(join(directory, `${bakeoffCacheKey(window, env, "one_pass")}.json`));
		let executions = 0;
		const report = await runBakeoff([window], env, {
			cacheDirectory: directory,
			executor: async (_strategy, value) => { executions++; return prediction(value, provider({ reportedTotalTokens: 95 })); },
		});
		assert.equal(executions, 1);
		assert.equal(report.strategies.two_stage.historicalStrategyCost.httpAttempts, 3);
		assert.equal(report.strategies.two_stage.historicalStrategyCost.reportedTotalTokens, 125);
		assert.equal(report.strategies.two_stage.historicalStrategyCost.tokenTelemetryMissingHttpAttempts, 1);
		assert.equal(report.strategies.two_stage.historicalStrategyCost.reportedTokensAreLowerBound, true);
		assert.equal(report.strategies.two_stage.historicalStrategyCost.httpAttemptLatencyMs, 900);
		assert.equal(report.strategies.two_stage.historicalStrategyCost.averageHttpAttemptLatencyMs, 300);
		assert.equal(report.strategies.two_stage.historicalStrategyCost.httpAttemptLatencyComplete, true);
		assert.equal(report.strategies.two_stage.currentRun.cacheHits, 1);
		assert.equal(report.strategies.two_stage.currentRun.provider.httpAttempts, 0);
		assert.equal(report.strategies.one_pass.currentRun.cacheHits, 0);
		assert.equal(report.strategies.one_pass.currentRun.provider.httpAttempts, 1);
		assert.equal(report.strategies.one_pass.historicalStrategyCost.reportedTotalTokens, 95);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("logical calls, HTTP attempts, retries, and 429s remain distinct", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ai-bakeoff-counts-"));
	try {
		const report = await runBakeoff([sampleWindow()], env, {
			cacheDirectory: directory, fresh: true,
			executor: async (_strategy, value) => prediction(value, provider({ logicalCalls: 1, httpAttempts: 3, httpRetries: 1, http429s: 2, outerRetries: 1, tokenTelemetryResponses: 1, httpAttemptLatencySamples: 3 })),
		});
		const metrics = report.strategies.one_pass.currentRun.provider;
		assert.equal(metrics.logicalCalls, 1);
		assert.equal(metrics.httpAttempts, 3);
		assert.equal(metrics.httpRetries, 1);
		assert.equal(metrics.http429s, 2);
		assert.equal(metrics.outerRetries, 1);
		assert.equal(metrics.tokenTelemetryMissingHttpAttempts, 2);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("failed windows explicitly disable quality comparison instead of becoming false negatives", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ai-bakeoff-failure-"));
	try {
		const report = await runBakeoff([sampleWindow()], env, {
			cacheDirectory: directory, fresh: true,
			executor: async (strategy, value) => {
				if (strategy === "one_pass") throw Object.assign(new Error("azure:test 503: unavailable"), { bakeoffProviderMetrics: provider({ reportedTotalTokens: 0, tokenTelemetryResponses: 0 }) });
				return prediction(value);
			},
		});
		assert.equal(report.comparisonReady, false);
		assert.equal(report.strategies.one_pass.quality.comparable, false);
		assert.match(report.strategies.one_pass.quality.caveat, /must not be compared/);
		assert.deepEqual(report.strategies.one_pass.quality.counts, { truePositives: 0, falsePositives: 0, falseNegatives: 0 });
		assert.equal(report.strategies.one_pass.currentRun.failedEvaluations, 1);
		assert.equal(report.strategies.one_pass.currentRun.provider.httpAttempts, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("outer transient and timeout retry policy is shared by every logical stage", async () => {
	for (const stage of ["extraction", "gate", "one_pass"]) {
		let calls = 0;
		let retries = 0;
		const result = await withBakeoffOuterRetries(
			{ AI_EVAL_PROVIDER_RETRIES: 1, AI_EVAL_MIN_INTERVAL_MS: 0 },
			() => retries++,
			async () => {
				calls++;
				if (calls === 1) throw new DOMException(`${stage} timed out`, "AbortError");
				return stage;
			},
			async () => undefined,
		);
		assert.equal(result, stage);
		assert.equal(calls, 2);
		assert.equal(retries, 1);
	}
	let structuredCalls = 0;
	await assert.rejects(withBakeoffOuterRetries(
		{ AI_EVAL_PROVIDER_RETRIES: 2, AI_EVAL_MIN_INTERVAL_MS: 0 }, () => undefined,
		async () => { structuredCalls++; throw new StructuredOutputError("invalid"); }, async () => undefined,
	), StructuredOutputError);
	assert.equal(structuredCalls, 1);
});

test("remote caches must match the expected strategy", () => {
	const entry = strategy => JSON.stringify({ version: BAKEOFF_VERSION, strategy, predicted: [sampleTask()], trace, provider: provider() });
	assert.equal(validBakeoffCacheEntry(entry("one_pass"), "one_pass"), true);
	assert.equal(validBakeoffCacheEntry(entry("one_pass"), "two_stage"), false);
	assert.equal(validBakeoffCacheEntry(entry("two_stage"), "two_stage"), true);
});

test("aggregate reports remain case-private", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ai-bakeoff-privacy-"));
	const window = sampleWindow();
	try {
		const report = await runBakeoff([window], env, { cacheDirectory: directory, fresh: true, executor: async (_strategy, value) => prediction(value) });
		assert.doesNotThrow(() => assertAggregateBakeoffReport(report));
		const serialized = JSON.stringify(report);
		for (const privateValue of [window.id, window.messages[0].id, window.messages[0].text, sampleTask().title, sampleTask().source_message_ids[0]]) {
			assert.equal(serialized.includes(privateValue), false);
		}
		assert.equal("cases" in report, false);
		assert.equal("predictions" in report, false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("aggregate report guard rejects case-level fields", () => {
	assert.throws(() => assertAggregateBakeoffReport({ cases: [{ id: "private" }] }), /forbidden case-level field/);
	assert.throws(() => assertAggregateBakeoffReport({ strategies: { one_pass: { sourceMessageIds: ["private"] } } }), /forbidden case-level field/);
});
