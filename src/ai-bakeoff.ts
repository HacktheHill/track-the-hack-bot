import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { contentHash, type CorpusWindow } from "./ai-corpus.js";
import {
	automaticCandidateEligible,
	AzureOnePassEvaluator,
	AzureTaskExtractor,
	extractedTaskSchema,
	mergeRelatedTaskCandidates,
	StructuredOutputError,
	type AutomaticCandidateAssessment,
	type ExtractedTask,
	type MinimizedMessage,
	type OnePassEvaluationResult,
	type ProviderAttempt,
} from "./azure-openai.js";
import type { IntegrationConfig } from "./config.js";
import {
	evaluationEnvSchema,
	evaluationTrace,
	exactProposalMatchCount,
	optionalRatio,
	proposalDiagnostics,
	providerFailureCategory,
	retryableProviderFailure,
	runtimeProposalCandidates,
	runtimeReferenceValidCandidates,
} from "./evaluate-ai.js";

export const BAKEOFF_VERSION = "canonical-one-pass-v3";
export const bakeoffStrategies = ["two_stage", "one_pass"] as const;
export type BakeoffStrategy = typeof bakeoffStrategies[number];
type EvaluationEnv = z.infer<typeof evaluationEnvSchema>;
type Trace = ReturnType<typeof evaluationTrace>;
type ProviderMetrics = {
	logicalCalls: number;
	httpAttempts: number;
	httpRetries: number;
	http429s: number;
	outerRetries: number;
	reportedPromptTokens: number;
	reportedCompletionTokens: number;
	reportedTotalTokens: number;
	tokenTelemetryResponses: number;
	httpAttemptLatencyMs: number;
	httpAttemptLatencySamples: number;
};
type StrategyPrediction = { predicted: ExtractedTask[]; trace: Trace; provider: ProviderMetrics };
type StrategyResult = { prediction?: StrategyPrediction; cached: boolean; error?: unknown; runtimeLatencyMs: number };

const providerMetricsSchema = z.object({
	logicalCalls: z.number().int().min(0), httpAttempts: z.number().int().min(0), httpRetries: z.number().int().min(0), http429s: z.number().int().min(0), outerRetries: z.number().int().min(0),
	reportedPromptTokens: z.number().int().min(0), reportedCompletionTokens: z.number().int().min(0), reportedTotalTokens: z.number().int().min(0), tokenTelemetryResponses: z.number().int().min(0), httpAttemptLatencyMs: z.number().min(0), httpAttemptLatencySamples: z.number().int().min(0),
}).superRefine((metrics, context) => {
	if (metrics.httpRetries > metrics.httpAttempts) context.addIssue({ code: "custom", message: "HTTP retries cannot exceed HTTP attempts." });
	if (metrics.http429s > metrics.httpAttempts) context.addIssue({ code: "custom", message: "HTTP 429 responses cannot exceed HTTP attempts." });
	if (metrics.tokenTelemetryResponses > metrics.httpAttempts) context.addIssue({ code: "custom", message: "Token telemetry responses cannot exceed HTTP attempts." });
	if (metrics.httpAttemptLatencySamples > metrics.httpAttempts) context.addIssue({ code: "custom", message: "HTTP latency samples cannot exceed HTTP attempts." });
});
const traceSchema = z.object({
	extractedCandidates: z.number().int().min(0), referenceValidCandidates: z.number().int().min(0), groundedCandidates: z.number().int().min(0), finalCandidates: z.number().int().min(0),
	gateCriteriaFailures: z.object({ activation: z.number().int().min(0), remainingWork: z.number().int().min(0), durability: z.number().int().min(0), decisionReadiness: z.number().int().min(0), sensitivity: z.number().int().min(0) }),
});
export const bakeoffCacheEntrySchema = z.object({
	version: z.literal(BAKEOFF_VERSION),
	strategy: z.enum(bakeoffStrategies),
	predicted: z.array(extractedTaskSchema),
	trace: traceSchema,
	provider: providerMetricsSchema,
});

function emptyProviderMetrics(): ProviderMetrics {
	return {
		logicalCalls: 0, httpAttempts: 0, httpRetries: 0, http429s: 0, outerRetries: 0,
		reportedPromptTokens: 0, reportedCompletionTokens: 0, reportedTotalTokens: 0, tokenTelemetryResponses: 0, httpAttemptLatencyMs: 0, httpAttemptLatencySamples: 0,
	};
}

function addProviderMetrics(total: ProviderMetrics, value: ProviderMetrics) {
	for (const key of Object.keys(total) as Array<keyof ProviderMetrics>) total[key] += value[key];
}

function observeProvider(metrics: ProviderMetrics, attempt: ProviderAttempt) {
	metrics.httpAttempts++;
	metrics.httpAttemptLatencyMs += attempt.latencyMs;
	metrics.httpAttemptLatencySamples++;
	if (attempt.httpRetry) metrics.httpRetries++;
	if (attempt.status === 429) metrics.http429s++;
}

function addUsage(metrics: ProviderMetrics, usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined) {
	if (usage?.promptTokens === undefined || usage.completionTokens === undefined || usage.totalTokens === undefined) return;
	metrics.reportedPromptTokens += usage.promptTokens;
	metrics.reportedCompletionTokens += usage.completionTokens;
	metrics.reportedTotalTokens += usage.totalTokens;
	metrics.tokenTelemetryResponses++;
}

function sleep(milliseconds: number) {
	return new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));
}

export function bakeoffCacheKey(window: CorpusWindow, env: EvaluationEnv, strategy: BakeoffStrategy) {
	return contentHash({
		window,
		bakeoff: BAKEOFF_VERSION,
		strategy,
		deployment: env.AZURE_OPENAI_DEPLOYMENT,
		apiVersion: env.AZURE_OPENAI_API_VERSION,
		maxCompletionTokens: env.AZURE_OPENAI_MAX_COMPLETION_TOKENS,
		maxContextChars: env.OPENPROJECT_AI_MAX_CONTEXT_CHARS,
		maxImages: env.OPENPROJECT_AI_MAX_IMAGE_ATTACHMENTS,
	});
}

export function validBakeoffCacheEntry(value: string, strategy: BakeoffStrategy) {
	try {
		const parsed = bakeoffCacheEntrySchema.parse(JSON.parse(value));
		return parsed.strategy === strategy;
	} catch {
		return false;
	}
}

async function loadCache(directory: string, key: string, strategy: BakeoffStrategy) {
	try {
		const value = await readFile(resolve(directory, `${key}.json`), "utf8");
		if (!validBakeoffCacheEntry(value, strategy)) return undefined;
		return bakeoffCacheEntrySchema.parse(JSON.parse(value));
	} catch {
		return undefined;
	}
}

async function storeCache(directory: string, key: string, strategy: BakeoffStrategy, value: StrategyPrediction) {
	await mkdir(resolve(directory), { recursive: true, mode: 0o700 });
	const target = resolve(directory, `${key}.json`);
	const temporary = `${target}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ version: BAKEOFF_VERSION, strategy, ...value })}\n`, { mode: 0o600 });
	await rename(temporary, target);
	await chmod(target, 0o600);
}

export async function withBakeoffOuterRetries<T>(
	env: Pick<EvaluationEnv, "AI_EVAL_PROVIDER_RETRIES" | "AI_EVAL_MIN_INTERVAL_MS">,
	onRetry: () => void,
	operation: () => Promise<T>,
	wait: (milliseconds: number) => Promise<unknown> = sleep,
) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof StructuredOutputError || !retryableProviderFailure(error) || attempt >= env.AI_EVAL_PROVIDER_RETRIES) throw error;
			onRetry();
			await wait(Math.max(env.AI_EVAL_MIN_INTERVAL_MS, 1000) * (attempt + 1));
		}
	}
}

async function withStructuredRetry<T>(operation: () => Promise<T>) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await operation();
		} catch (error) {
			if (!(error instanceof StructuredOutputError) || attempt >= 1) throw error;
		}
	}
}

function attachProviderMetrics(error: unknown, provider: ProviderMetrics) {
	if (error && typeof error === "object") Object.assign(error, { bakeoffProviderMetrics: provider });
	return error;
}

export function canonicalOnePassPrediction(result: OnePassEvaluationResult, window: CorpusWindow) {
	const referenceValid = runtimeReferenceValidCandidates(result.result.tasks, window.messages as MinimizedMessage[]);
	if (referenceValid.length !== result.result.tasks.length) throw new StructuredOutputError("One-pass canonical candidates failed deterministic reference validation.");
	const grounded = mergeRelatedTaskCandidates(referenceValid);
	if (grounded.length !== referenceValid.length) throw new StructuredOutputError("One-pass output contained candidates that were not canonical.");
	const eligible = grounded.filter((_, index) => window.mode === "manual" || automaticCandidateEligible(result.assessments[index], result.windowSensitivity));
	const predicted = runtimeProposalCandidates(eligible, window.messages as MinimizedMessage[], window.routing, "manual");
	return { predicted, referenceValid, grounded };
}

async function executeTwoStage(window: CorpusWindow, env: EvaluationEnv, beforeAdditionalCall: () => Promise<void>): Promise<StrategyPrediction> {
	const provider = emptyProviderMetrics();
	try {
		const extractor = new AzureTaskExtractor(env as unknown as IntegrationConfig, undefined, attempt => observeProvider(provider, attempt));
		provider.logicalCalls++;
		const extraction = await withBakeoffOuterRetries(env, () => provider.outerRetries++, () => extractor.extract(window.messages as MinimizedMessage[], { mode: window.mode, metadata: window.metadata }));
		addUsage(provider, extraction.usage);
		const referenceValid = runtimeReferenceValidCandidates(extraction.result.tasks, window.messages as MinimizedMessage[]);
		const grounded = mergeRelatedTaskCandidates(referenceValid);
		let assessments: AutomaticCandidateAssessment[] = [];
		let windowSensitivity: "safe" | "sensitive" | "uncertain" = window.mode === "manual" ? "safe" : "uncertain";
		if (window.mode === "automatic" && grounded.length) {
			await beforeAdditionalCall();
			provider.logicalCalls++;
			const gate = await withBakeoffOuterRetries(env, () => provider.outerRetries++, () => extractor.assessAutomaticCandidates(extraction.inputMessages, grounded));
			assessments = gate.assessments;
			windowSensitivity = gate.windowSensitivity;
			addUsage(provider, gate.usage);
		}
		const predicted = runtimeProposalCandidates(extraction.result.tasks, window.messages as MinimizedMessage[], window.routing, window.mode, assessments, windowSensitivity);
		return { predicted, trace: evaluationTrace(extraction.result.tasks.length, referenceValid.length, grounded.length, assessments, predicted.length), provider };
	} catch (error) {
		throw attachProviderMetrics(error, provider);
	}
}

async function executeOnePass(window: CorpusWindow, env: EvaluationEnv): Promise<StrategyPrediction> {
	const provider = emptyProviderMetrics();
	try {
		const evaluator = new AzureOnePassEvaluator(env as unknown as IntegrationConfig, undefined, attempt => observeProvider(provider, attempt));
		provider.logicalCalls++;
		const result = await withBakeoffOuterRetries(env, () => provider.outerRetries++, () => withStructuredRetry(() => evaluator.evaluate(window.messages as MinimizedMessage[], { mode: window.mode, metadata: window.metadata })));
		addUsage(provider, result.usage);
		const { predicted, referenceValid, grounded } = canonicalOnePassPrediction(result, window);
		return { predicted, trace: evaluationTrace(result.result.tasks.length, referenceValid.length, grounded.length, result.assessments, predicted.length), provider };
	} catch (error) {
		throw attachProviderMetrics(error, provider);
	}
}

export type BakeoffExecutor = (strategy: BakeoffStrategy, window: CorpusWindow, env: EvaluationEnv, beforeAdditionalCall: () => Promise<void>) => Promise<StrategyPrediction>;

function ratio(numerator: number, denominator: number) {
	return denominator ? numerator / denominator : 0;
}

function reportedProviderMetrics(provider: ProviderMetrics) {
	const missingTokens = Math.max(0, provider.httpAttempts - provider.tokenTelemetryResponses);
	const missingLatency = Math.max(0, provider.httpAttempts - provider.httpAttemptLatencySamples);
	return {
		...provider,
		tokenTelemetryMissingHttpAttempts: missingTokens,
		tokenTelemetryComplete: missingTokens === 0,
		reportedTokensAreLowerBound: missingTokens > 0,
		httpAttemptLatencyMissingSamples: missingLatency,
		httpAttemptLatencyComplete: missingLatency === 0,
	};
}

function aggregateStrategy(windows: CorpusWindow[], results: StrategyResult[]) {
	let truePositives = 0;
	let falsePositives = 0;
	let falseNegatives = 0;
	let validOutputs = 0;
	let failedWindows = 0;
	let cacheHits = 0;
	let runtimeLatencyMs = 0;
	const historicalProvider = emptyProviderMetrics();
	const currentProvider = emptyProviderMetrics();
	const errors: Record<string, number> = {};
	const diagnostics = {
		detection: { truePositives: 0, falsePositives: 0, falseNegatives: 0 },
		action: { correct: 0, compared: 0 }, sources: { truePositives: 0, falsePositives: 0, falseNegatives: 0 },
		titleConcepts: { matched: 0, expected: 0 }, project: { correct: 0, compared: 0 }, owner: { correct: 0, compared: 0 }, deadline: { correct: 0, compared: 0 },
	};
	for (let index = 0; index < windows.length; index++) {
		const window = windows[index]!;
		const item = results[index]!;
		runtimeLatencyMs += item.runtimeLatencyMs;
		if (!item.prediction) {
			failedWindows++;
			const failedProvider = item.error && typeof item.error === "object" && "bakeoffProviderMetrics" in item.error
				? (item.error as { bakeoffProviderMetrics: ProviderMetrics }).bakeoffProviderMetrics
				: emptyProviderMetrics();
			addProviderMetrics(currentProvider, failedProvider);
			const category = providerFailureCategory(item.error);
			errors[category] = (errors[category] ?? 0) + 1;
			continue;
		}
		validOutputs++;
		addProviderMetrics(historicalProvider, item.prediction.provider);
		if (item.cached) cacheHits++;
		else addProviderMetrics(currentProvider, item.prediction.provider);
		const detail = proposalDiagnostics(window.expected.proposals, item.prediction.predicted);
		for (const key of ["truePositives", "falsePositives", "falseNegatives"] as const) diagnostics.detection[key] += detail.detection[key];
		for (const key of ["truePositives", "falsePositives", "falseNegatives"] as const) diagnostics.sources[key] += detail.sources[key];
		for (const component of ["action", "project", "owner", "deadline"] as const) {
			diagnostics[component].correct += detail[component].correct;
			diagnostics[component].compared += detail[component].compared;
		}
		diagnostics.titleConcepts.matched += detail.titleConcepts.matched;
		diagnostics.titleConcepts.expected += detail.titleConcepts.expected;
		const exactMatches = exactProposalMatchCount(window.expected.proposals, item.prediction.predicted);
		truePositives += exactMatches;
		falsePositives += item.prediction.predicted.length - exactMatches;
		falseNegatives += window.expected.proposals.length - exactMatches;
	}
	const comparable = failedWindows === 0;
	return {
		quality: {
			comparable,
			caveat: comparable ? null : "Quality metrics cover successful windows only and must not be compared between strategies while failures remain.",
			evaluatedWindows: validOutputs,
			failedWindows,
			proposalPrecision: ratio(truePositives, truePositives + falsePositives),
			proposalRecall: ratio(truePositives, truePositives + falseNegatives),
			actionAccuracy: optionalRatio(diagnostics.action.correct, diagnostics.action.compared),
			sourcePrecision: optionalRatio(diagnostics.sources.truePositives, diagnostics.sources.truePositives + diagnostics.sources.falsePositives),
			sourceRecall: optionalRatio(diagnostics.sources.truePositives, diagnostics.sources.truePositives + diagnostics.sources.falseNegatives),
			titleConceptRecall: optionalRatio(diagnostics.titleConcepts.matched, diagnostics.titleConcepts.expected),
			projectAccuracy: optionalRatio(diagnostics.project.correct, diagnostics.project.compared),
			ownerAccuracy: optionalRatio(diagnostics.owner.correct, diagnostics.owner.compared),
			deadlineAccuracy: optionalRatio(diagnostics.deadline.correct, diagnostics.deadline.compared),
			validOutputRate: ratio(validOutputs, windows.length),
			counts: { truePositives, falsePositives, falseNegatives },
		},
		historicalStrategyCost: {
			...reportedProviderMetrics(historicalProvider),
			averageHttpAttemptLatencyMs: ratio(historicalProvider.httpAttemptLatencyMs, historicalProvider.httpAttempts),
			coveredWindows: validOutputs,
		},
		currentRun: {
			cacheHits,
			cacheMisses: windows.length - cacheHits,
			successfulEvaluations: validOutputs - cacheHits,
			failedEvaluations: failedWindows,
			evaluationWallLatencyMs: runtimeLatencyMs,
			provider: reportedProviderMetrics(currentProvider),
		},
		errors,
	};
}

export async function runBakeoff(
	windows: CorpusWindow[],
	env: EvaluationEnv,
	options: { cacheDirectory: string; fresh?: boolean; full?: boolean; executor?: BakeoffExecutor } = { cacheDirectory: env.AI_EVAL_CACHE_DIR },
) {
	const snapshot = windows;
	const cached = {} as Record<BakeoffStrategy, Array<StrategyPrediction | undefined>>;
	for (const strategy of bakeoffStrategies) {
		cached[strategy] = await Promise.all(snapshot.map(window => options.fresh ? undefined : loadCache(options.cacheDirectory, bakeoffCacheKey(window, env, strategy), strategy)));
	}
	const uncachedWindows = snapshot.filter((_, index) => bakeoffStrategies.some(strategy => !cached[strategy][index])).length;
	if (!options.full && uncachedWindows > env.AI_EVAL_MAX_UNCACHED_CASES) {
		throw new Error(`${uncachedWindows} corpus windows require provider calls, exceeding AI_EVAL_MAX_UNCACHED_CASES=${env.AI_EVAL_MAX_UNCACHED_CASES}. Re-run the dedicated Blob entrypoint with --full to opt in.`);
	}
	let lastCallAt = 0;
	const beforeProviderCall = async () => {
		const waitFor = Math.max(0, env.AI_EVAL_MIN_INTERVAL_MS - (Date.now() - lastCallAt));
		if (waitFor) await sleep(waitFor);
		lastCallAt = Date.now();
	};
	const execute = options.executor ?? ((strategy, window, evaluationEnv, beforeAdditionalCall) => strategy === "two_stage"
		? executeTwoStage(window, evaluationEnv, beforeAdditionalCall)
		: executeOnePass(window, evaluationEnv));
	const strategyResults = Object.fromEntries(bakeoffStrategies.map(strategy => [strategy, Array<StrategyResult>(snapshot.length)])) as Record<BakeoffStrategy, StrategyResult[]>;
	for (let index = 0; index < snapshot.length; index++) {
		const order = index % 2 === 0 ? bakeoffStrategies : [...bakeoffStrategies].reverse();
		for (const strategy of order) {
			const cachedPrediction = cached[strategy][index];
			if (cachedPrediction) {
				strategyResults[strategy][index] = { prediction: cachedPrediction, cached: true, runtimeLatencyMs: 0 };
				continue;
			}
			await beforeProviderCall();
			const started = Date.now();
			try {
				const prediction = await execute(strategy, snapshot[index]!, env, beforeProviderCall);
				await storeCache(options.cacheDirectory, bakeoffCacheKey(snapshot[index]!, env, strategy), strategy, prediction);
				strategyResults[strategy][index] = { prediction, cached: false, runtimeLatencyMs: Date.now() - started };
			} catch (error) {
				strategyResults[strategy][index] = { cached: false, error, runtimeLatencyMs: Date.now() - started };
			}
		}
	}
	const strategies = Object.fromEntries(bakeoffStrategies.map(strategy => [strategy, aggregateStrategy(snapshot, strategyResults[strategy])])) as Record<BakeoffStrategy, ReturnType<typeof aggregateStrategy>>;
	return {
		schemaVersion: "v2",
		generatedAt: new Date().toISOString(),
		bakeoffVersion: BAKEOFF_VERSION,
		corpusWindows: snapshot.length,
		uncachedWindows,
		snapshotDigest: contentHash(snapshot),
		model: env.AZURE_OPENAI_DEPLOYMENT,
		comparisonReady: bakeoffStrategies.every(strategy => strategies[strategy].quality.comparable),
		strategies,
	};
}

export function assertAggregateBakeoffReport(report: unknown) {
	const forbidden = new Set(["id", "caseId", "cases", "text", "messages", "predicted", "predictions", "sourceMessageIds", "source_message_ids"]);
	const visit = (value: unknown) => {
		if (Array.isArray(value)) return value.forEach(visit);
		if (!value || typeof value !== "object") return;
		for (const [key, item] of Object.entries(value)) {
			if (forbidden.has(key)) throw new Error(`Bakeoff report contains forbidden case-level field: ${key}`);
			visit(item);
		}
	};
	visit(report);
	return report;
}
