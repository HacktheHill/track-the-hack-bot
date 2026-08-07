import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";
import { automaticCandidateEligible, AzureTaskExtractor, mergeRelatedTaskCandidates, StructuredOutputError, type AutomaticCandidateAssessment, type ExtractedTasks, type MinimizedMessage } from "./azure-openai.js";
import { contentHash, corpusWindowSchema, parseCorpusJsonl } from "./ai-corpus.js";
import type { IntegrationConfig } from "./config.js";
import { resolveProposedAction } from "./rag.js";
import { taskReferencesAreValid } from "./task-proposals.js";
import { normalizeProjectName } from "./project-resolution.js";

loadDotEnv();

export { corpusWindowSchema } from "./ai-corpus.js";

export const evaluationEnvSchema = z.object({
	AZURE_OPENAI_ENDPOINT: z.url(),
	AZURE_OPENAI_DEPLOYMENT: z.string().min(1),
	AZURE_OPENAI_API_VERSION: z.string().default("v1"),
	AZURE_OPENAI_MAX_COMPLETION_TOKENS: z.coerce.number().int().min(64).max(4096).default(4096),
	AZURE_OPENAI_CHAT_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
	AZURE_OPENAI_CHAT_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(60000).default(1000),
	OPENPROJECT_AI_MAX_CONTEXT_CHARS: z.coerce.number().int().min(2000).max(100000).default(16000),
	OPENPROJECT_AI_MAX_IMAGE_ATTACHMENTS: z.coerce.number().int().min(0).max(20).default(0),
	AI_EVAL_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(60000).default(0),
	AI_EVAL_PROVIDER_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
	AI_EVAL_CACHE_DIR: z.string().default(".private/ai-eval-cache"),
	AI_EVAL_MAX_UNCACHED_CASES: z.coerce.number().int().min(1).max(10000).default(25),
	AI_EVAL_RELEASE_MIN_WINDOWS: z.coerce.number().int().min(1).max(100000).default(100),
	AI_EVAL_RELEASE_MIN_PROPOSAL_PRECISION: z.coerce.number().min(0).max(1).default(0.95),
	AI_EVAL_RELEASE_MIN_VALID_OUTPUT_RATE: z.coerce.number().min(0).max(1).default(0.99),
});

type ExtractedTask = ExtractedTasks["tasks"][number];

export function runtimeProposalCandidates(
	tasks: ExtractedTask[],
	messages: MinimizedMessage[],
	routing: { availableTargetSourceMessageIds?: string[][] } = {},
	mode: "manual" | "automatic" = "automatic",
	automaticAssessments: AutomaticCandidateAssessment[] = [],
) {
	const grounded = runtimeGroundedCandidates(tasks, messages);
	const eligible = mode === "automatic"
		? grounded.filter((_, index) => automaticCandidateEligible(automaticAssessments[index]))
		: grounded;
	return eligible.filter(task => {
		const targetAvailable = routing.availableTargetSourceMessageIds?.some(ids => ids.every(id => task.source_message_ids.includes(id))) ?? false;
		return resolveProposedAction(task.proposed_action, targetAvailable) !== "no_action";
	});
}

export function runtimeGroundedCandidates(tasks: ExtractedTask[], messages: MinimizedMessage[]) {
	const validMessageIds = new Set(messages.map(message => message.id));
	const focalMessageIds = new Set(messages
		.filter(message => message.contextRole === "primary" || message.priority)
		.map(message => message.id));
	const validAttachmentIds = new Set(messages.flatMap(message => (message.attachments ?? []).map(attachment => attachment.id)));
	return mergeRelatedTaskCandidates(tasks.filter(task => taskReferencesAreValid(task, validMessageIds, focalMessageIds, validAttachmentIds)));
}

function ratio(numerator: number, denominator: number) {
	return denominator ? numerator / denominator : 0;
}

export function optionalRatio(numerator: number, denominator: number) {
	return denominator ? numerator / denominator : null;
}

function sameSet(left: string[], right: string[]) {
	return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function percent(value: number) {
	return `${(value * 100).toFixed(1)}%`;
}

function sleep(milliseconds: number) {
	return new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));
}

const EVALUATOR_PIPELINE_VERSION = "automatic-v3.4";
const evaluationTraceSchema = z.object({
	extractedCandidates: z.number().int().min(0),
	groundedCandidates: z.number().int().min(0),
	finalCandidates: z.number().int().min(0),
	gateCriteriaFailures: z.object({ activation: z.number().int().min(0), remainingWork: z.number().int().min(0), durability: z.number().int().min(0), decisionReadiness: z.number().int().min(0), sensitivity: z.number().int().min(0) }),
});
const cachedCaseSchema = z.object({
	version: z.literal(EVALUATOR_PIPELINE_VERSION),
	predicted: z.array(z.unknown()),
	trace: evaluationTraceSchema,
});

export function evaluationTrace(extractedCandidates: number, groundedCandidates: number, assessments: AutomaticCandidateAssessment[], finalCandidates: number) {
	return evaluationTraceSchema.parse({
		extractedCandidates,
		groundedCandidates,
		finalCandidates,
		gateCriteriaFailures: {
			activation: assessments.filter(item => !item.has_activated_specific_work).length,
			remainingWork: assessments.filter(item => !item.has_remaining_work_or_trackable_transition).length,
			durability: assessments.filter(item => !item.is_durable).length,
			decisionReadiness: assessments.filter(item => !item.is_decision_ready).length,
			sensitivity: assessments.filter(item => item.sensitivity !== "safe").length,
		},
	});
}

async function cachedPrediction(directory: string, key: string) {
	try {
		const cached = cachedCaseSchema.parse(JSON.parse(await readFile(resolve(directory, `${key}.json`), "utf8")));
		return { predicted: cached.predicted as ExtractedTask[], trace: cached.trace };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return undefined;
	}
}

async function storePrediction(directory: string, key: string, predicted: ExtractedTask[], trace: z.infer<typeof evaluationTraceSchema>) {
	await mkdir(resolve(directory), { recursive: true, mode: 0o700 });
	const target = resolve(directory, `${key}.json`);
	const temporary = `${target}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ version: EVALUATOR_PIPELINE_VERSION, predicted, trace })}\n`, { mode: 0o600 });
	await rename(temporary, target);
	await chmod(target, 0o600);
}

export function evaluationCacheKey(window: z.infer<typeof corpusWindowSchema>, env: z.infer<typeof evaluationEnvSchema>) {
	return contentHash({
		window,
		pipeline: EVALUATOR_PIPELINE_VERSION,
		deployment: env.AZURE_OPENAI_DEPLOYMENT,
		apiVersion: env.AZURE_OPENAI_API_VERSION,
		maxCompletionTokens: env.AZURE_OPENAI_MAX_COMPLETION_TOKENS,
		maxContextChars: env.OPENPROJECT_AI_MAX_CONTEXT_CHARS,
		maxImages: env.OPENPROJECT_AI_MAX_IMAGE_ATTACHMENTS,
	});
}

export function providerFailureCategory(error: unknown) {
	if (error instanceof StructuredOutputError) return "invalid_output";
	const message = error instanceof Error ? error.message : String(error);
	const status = message.match(/\s([45]\d\d):/)?.[1];
	if (status) return `http_${status}`;
	if (error instanceof Error && error.name === "AbortError") return "timeout";
	if (error instanceof TypeError) return "network_error";
	return "provider_error";
}

export function retryableProviderFailure(error: unknown) {
	const category = providerFailureCategory(error);
	return category === "timeout" || category === "network_error" || ["http_408", "http_409", "http_425", "http_429", "http_500", "http_502", "http_503", "http_504"].includes(category);
}

export type ReleaseThresholdFailure = { metric: "corpusWindows" | "proposalPrecision" | "validOutputRate"; actual: number; threshold: number };

export function releaseThresholdFailures(
	metrics: { corpusWindows: number; proposalPrecision: number; validOutputRate: number },
	thresholds: { minimumWindows: number; proposalPrecision: number; validOutputRate: number },
) {
	const failures: ReleaseThresholdFailure[] = [];
	if (metrics.corpusWindows < thresholds.minimumWindows) failures.push({ metric: "corpusWindows", actual: metrics.corpusWindows, threshold: thresholds.minimumWindows });
	if (metrics.proposalPrecision < thresholds.proposalPrecision) failures.push({ metric: "proposalPrecision", actual: metrics.proposalPrecision, threshold: thresholds.proposalPrecision });
	if (metrics.validOutputRate < thresholds.validOutputRate) failures.push({ metric: "validOutputRate", actual: metrics.validOutputRate, threshold: thresholds.validOutputRate });
	return failures;
}

async function main() {
	const inputPath = process.argv[2];
	if (!inputPath) throw new Error("Usage: npm run evaluate:ai -- <private-corpus.jsonl> [output-prefix] [--case <id>] [--changed] [--fresh] [--full]");
	const cli = process.argv.slice(3);
	const outputArgument = cli[0] && !cli[0].startsWith("--") ? cli.shift() : undefined;
	const caseIndex = cli.indexOf("--case");
	const selectedCaseId = caseIndex >= 0 ? cli[caseIndex + 1] : undefined;
	const fresh = cli.includes("--fresh");
	const changedOnly = cli.includes("--changed");
	const full = cli.includes("--full");
	const absoluteInput = resolve(inputPath);
	const outputPrefix = resolve(outputArgument ?? `${absoluteInput}.report`);
	let windows = parseCorpusJsonl(await readFile(absoluteInput, "utf8"));
	const env = evaluationEnvSchema.parse(process.env);
	if (selectedCaseId) windows = windows.filter(window => window.id === selectedCaseId);
	if (selectedCaseId && !windows.length) throw new Error(`Corpus case was not found: ${selectedCaseId}`);
	const prepared = await Promise.all(windows.map(async window => {
		const key = evaluationCacheKey(window, env);
		return { window, key, cached: fresh ? undefined : await cachedPrediction(env.AI_EVAL_CACHE_DIR, key) };
	}));
	if (changedOnly) windows = prepared.filter(item => !item.cached).map(item => item.window);
	const selected = prepared.filter(item => windows.some(window => window.id === item.window.id));
	const uncachedCount = selected.filter(item => !item.cached).length;
	if (!full && uncachedCount > env.AI_EVAL_MAX_UNCACHED_CASES) {
		throw new Error(`${uncachedCount} cases require Azure calls, exceeding AI_EVAL_MAX_UNCACHED_CASES=${env.AI_EVAL_MAX_UNCACHED_CASES}. Use --case, --changed, or explicitly pass --full.`);
	}
	const extractor = new AzureTaskExtractor(env as unknown as IntegrationConfig);
	let truePositives = 0;
	let falsePositives = 0;
	let falseNegatives = 0;
	let validOutputs = 0;
	let invalidOutputs = 0;
	let providerErrors = 0;
	let ownerCorrect = 0;
	let ownerCompared = 0;
	let deadlineCorrect = 0;
	let deadlineCompared = 0;
	let totalLatencyMs = 0;
	let latencySamples = 0;
	let totalTokens = 0;
	let providerRetries = 0;
	let cacheHits = 0;
	let lastRequestAt = 0;
	const providerErrorCategories: Record<string, number> = {};
	const cases: Array<Record<string, unknown>> = [];
	const stageTotals = {
		extractedCandidates: 0, groundedCandidates: 0, finalCandidates: 0,
		gateCriteriaFailures: { activation: 0, remainingWork: 0, durability: 0, decisionReadiness: 0, sensitivity: 0 },
	};

	for (const item of selected) {
		const { window } = item;
		try {
			let predicted: ExtractedTask[];
			let trace: z.infer<typeof evaluationTraceSchema>;
			if (item.cached) {
				predicted = item.cached.predicted;
				trace = item.cached.trace;
				cacheHits++;
				validOutputs++;
			} else {
			let extraction: Awaited<ReturnType<AzureTaskExtractor["extract"]>> | undefined;
			for (let attempt = 0; attempt <= env.AI_EVAL_PROVIDER_RETRIES; attempt++) {
				const waitFor = Math.max(0, env.AI_EVAL_MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
				if (waitFor) await sleep(waitFor);
				lastRequestAt = Date.now();
				try {
					extraction = await extractor.extract(window.messages as MinimizedMessage[], { mode: window.mode, metadata: window.metadata });
					break;
				} catch (error) {
					if (error instanceof StructuredOutputError || !retryableProviderFailure(error) || attempt === env.AI_EVAL_PROVIDER_RETRIES) throw error;
					providerRetries++;
					await sleep(Math.max(env.AI_EVAL_MIN_INTERVAL_MS, 1000) * (attempt + 1));
				}
			}
			if (!extraction) throw new Error("AI evaluation exhausted retries without a result.");
			totalLatencyMs += extraction.latencyMs;
			latencySamples++;
			totalTokens += extraction.usage?.totalTokens ?? 0;
			const grounded = runtimeGroundedCandidates(extraction.result.tasks, window.messages as MinimizedMessage[]);
			let assessments: AutomaticCandidateAssessment[] = [];
			if (window.mode === "automatic" && grounded.length) {
				const waitForGate = Math.max(0, env.AI_EVAL_MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
				if (waitForGate) await sleep(waitForGate);
				lastRequestAt = Date.now();
				const gate = await extractor.assessAutomaticCandidates(extraction.inputMessages, grounded);
				assessments = gate.assessments;
				totalLatencyMs += gate.latencyMs;
				totalTokens += gate.usage?.totalTokens ?? 0;
			}
			predicted = runtimeProposalCandidates(extraction.result.tasks, window.messages as MinimizedMessage[], window.routing, window.mode, assessments);
			trace = evaluationTrace(extraction.result.tasks.length, grounded.length, assessments, predicted.length);
			await storePrediction(env.AI_EVAL_CACHE_DIR, item.key, predicted, trace);
			validOutputs++;
			}
			stageTotals.extractedCandidates += trace.extractedCandidates;
			stageTotals.groundedCandidates += trace.groundedCandidates;
			stageTotals.finalCandidates += trace.finalCandidates;
			for (const key of Object.keys(stageTotals.gateCriteriaFailures) as Array<keyof typeof stageTotals.gateCriteriaFailures>) {
				stageTotals.gateCriteriaFailures[key] += trace.gateCriteriaFailures[key];
			}
			const unmatched = new Set(predicted.map((_, index) => index));
			let matched = 0;
			for (const expected of window.expected.proposals) {
				const index = [...unmatched].find(candidateIndex => {
					const candidate = predicted[candidateIndex];
					if (!candidate || candidate.proposed_action !== expected.action || !sameSet(candidate.source_message_ids, expected.sourceMessageIds)) return false;
					if (expected.projectName !== undefined) {
						const actualProject = candidate.project_name ? normalizeProjectName(candidate.project_name) : null;
						const expectedProject = expected.projectName ? normalizeProjectName(expected.projectName) : null;
						if (actualProject !== expectedProject) return false;
					}
					const content = `${candidate.title}\n${candidate.description}`.toLocaleLowerCase();
					return expected.titleIncludes.every(term => content.includes(term.toLocaleLowerCase()));
				});
				if (index === undefined) continue;
				const candidate = predicted[index]!;
				unmatched.delete(index);
				matched++;
				if (expected.assigneeAlias !== undefined) {
					ownerCompared++;
					if (candidate.assignee_alias === expected.assigneeAlias) ownerCorrect++;
				}
				if (expected.dueDate !== undefined) {
					deadlineCompared++;
					if (candidate.due_date === expected.dueDate) deadlineCorrect++;
				}
			}
			truePositives += matched;
			falseNegatives += window.expected.proposals.length - matched;
			falsePositives += predicted.length - matched;
			cases.push({ id: window.id, expectedProposals: window.expected.proposals.length, predictedProposals: predicted.length, matchedProposals: matched, validOutput: true, cached: Boolean(item.cached), trace });
		} catch (error) {
			if (error instanceof StructuredOutputError) invalidOutputs++;
			else {
				providerErrors++;
				const category = providerFailureCategory(error);
				providerErrorCategories[category] = (providerErrorCategories[category] ?? 0) + 1;
			}
			falseNegatives += window.expected.proposals.length;
			cases.push({ id: window.id, expectedProposals: window.expected.proposals.length, predictedProposals: 0, matchedProposals: 0, validOutput: false, errorType: providerFailureCategory(error) });
		}
	}

	const thresholds = {
		minimumWindows: env.AI_EVAL_RELEASE_MIN_WINDOWS,
		proposalPrecision: env.AI_EVAL_RELEASE_MIN_PROPOSAL_PRECISION,
		validOutputRate: env.AI_EVAL_RELEASE_MIN_VALID_OUTPUT_RATE,
	};
	const thresholdFailures = releaseThresholdFailures({
		corpusWindows: selected.length,
		proposalPrecision: ratio(truePositives, truePositives + falsePositives),
		validOutputRate: ratio(validOutputs, selected.length),
	}, thresholds);
	const report = {
		generatedAt: new Date().toISOString(),
		corpusWindows: selected.length,
		model: env.AZURE_OPENAI_DEPLOYMENT,
		metrics: {
			proposalPrecision: ratio(truePositives, truePositives + falsePositives),
			proposalRecall: ratio(truePositives, truePositives + falseNegatives),
			ownerAccuracy: optionalRatio(ownerCorrect, ownerCompared),
			deadlineAccuracy: optionalRatio(deadlineCorrect, deadlineCompared),
			ownerComparisons: ownerCompared,
			deadlineComparisons: deadlineCompared,
			validOutputRate: ratio(validOutputs, selected.length),
			averageLatencyMs: ratio(totalLatencyMs, latencySamples),
			totalTokens,
			invalidOutputs,
			providerErrors,
			providerRetries,
			cacheHits,
			uncachedCases: uncachedCount,
		},
		counts: { truePositives, falsePositives, falseNegatives },
		stageTotals,
		providerErrorCategories,
		thresholds,
		passed: thresholdFailures.length === 0,
		thresholdFailures,
		cases,
	};
	const markdown = [
		"# AI task extraction evaluation",
		"",
		`Generated: ${report.generatedAt}`,
		`Model: ${report.model}`,
		`Corpus windows: ${report.corpusWindows} (${cacheHits} cached; ${uncachedCount} requiring Azure calls; minimum ${thresholds.minimumWindows})`,
		`Release thresholds: ${report.passed ? "PASSED" : "FAILED"}`,
		"",
		"| Metric | Result | Target |",
		"| --- | ---: | ---: |",
		`| Proposal precision | ${validOutputs ? percent(report.metrics.proposalPrecision) : "N/A"} | ${percent(thresholds.proposalPrecision)} |`,
		`| Proposal recall | ${validOutputs ? percent(report.metrics.proposalRecall) : "N/A"} | — |`,
		`| Owner accuracy | ${validOutputs && report.metrics.ownerAccuracy !== null ? percent(report.metrics.ownerAccuracy) : "N/A"} | — |`,
		`| Deadline accuracy | ${validOutputs && report.metrics.deadlineAccuracy !== null ? percent(report.metrics.deadlineAccuracy) : "N/A"} | — |`,
		`| Valid structured output | ${percent(report.metrics.validOutputRate)} | ${percent(thresholds.validOutputRate)} |`,
		`| Average latency | ${Math.round(report.metrics.averageLatencyMs)} ms | — |`,
		`| Total tokens | ${report.metrics.totalTokens} | — |`,
		`| Provider retries | ${report.metrics.providerRetries} | — |`,
		`| Cache hits | ${report.metrics.cacheHits} | — |`,
		"",
		`Invalid outputs: ${invalidOutputs}; provider errors: ${providerErrors}.`,
		providerErrors ? `Provider error categories: ${Object.entries(providerErrorCategories).map(([category, count]) => `${category}=${count}`).join(", ")}.` : "",
		thresholdFailures.length ? `Release threshold failures: ${thresholdFailures.map(failure => `${failure.metric}=${failure.actual} (minimum ${failure.threshold})`).join("; ")}.` : "",
		!validOutputs ? "\n> Evaluation incomplete: no valid model outputs were produced. Quality metrics are unavailable; fix provider access before using this report for a rollout decision." : "",
		selected.length < thresholds.minimumWindows ? `\n> Warning: this run has fewer than the required ${thresholds.minimumWindows} representative windows.` : "",
	].join("\n");
	await writeFile(`${outputPrefix}.json`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
	await writeFile(`${outputPrefix}.md`, `${markdown}\n`, { mode: 0o600 });
	console.log(markdown);
	console.log(`\nReports written to ${outputPrefix}.json and ${outputPrefix}.md`);
	if (full && !report.passed) throw new Error("AI evaluation failed release thresholds; reports were written.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch(error => {
		console.error((error as Error).message);
		process.exitCode = 1;
	});
}
