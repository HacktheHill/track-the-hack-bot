import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";
import { automaticCandidateEligible, AzureTaskExtractor, mergeRelatedTaskCandidates, StructuredOutputError, type AutomaticCandidateAssessment, type ExtractedTasks, type MinimizedMessage } from "./azure-openai.js";
import { contentHash, corpusWindowSchema, parseCorpusJsonl } from "./ai-corpus.js";
import type { IntegrationConfig } from "./config.js";
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
type ExpectedProposal = z.infer<typeof corpusWindowSchema>["expected"]["proposals"][number];

type ProposalPair = {
	expectedIndex: number;
	predictedIndex: number;
	score: number;
};

type ProposalDiagnostics = {
	alignedProposals: number;
	detection: { truePositives: number; falsePositives: number; falseNegatives: number };
	action: { correct: number; compared: number };
	sources: { truePositives: number; falsePositives: number; falseNegatives: number };
	titleConcepts: { matched: number; expected: number };
	project: { correct: number; compared: number };
	owner: { correct: number; compared: number };
	deadline: { correct: number; compared: number };
};

export function runtimeProposalCandidates(
	tasks: ExtractedTask[],
	messages: MinimizedMessage[],
	routing: { availableTargetSourceMessageIds?: string[][] } = {},
	mode: "manual" | "automatic" = "automatic",
	automaticAssessments: AutomaticCandidateAssessment[] = [],
	windowSensitivity: "safe" | "sensitive" | "uncertain" = "uncertain",
) {
	const grounded = runtimeGroundedCandidates(tasks, messages);
	const eligible = mode === "automatic"
		? grounded.filter((_, index) => automaticCandidateEligible(automaticAssessments[index], windowSensitivity))
		: grounded;
	void routing;
	return eligible;
}

export function runtimeGroundedCandidates(tasks: ExtractedTask[], messages: MinimizedMessage[]) {
	return mergeRelatedTaskCandidates(runtimeReferenceValidCandidates(tasks, messages));
}

function runtimeReferenceValidCandidates(tasks: ExtractedTask[], messages: MinimizedMessage[]) {
	const validMessageIds = new Set(messages.map(message => message.id));
	const focalMessageIds = new Set(messages
		.filter(message => message.contextRole === "primary" || message.priority)
		.map(message => message.id));
	const validAttachmentIds = new Set(messages.flatMap(message => (message.attachments ?? []).map(attachment => attachment.id)));
	return tasks.filter(task => taskReferencesAreValid(task, validMessageIds, focalMessageIds, validAttachmentIds));
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

function normalizedProject(value: string | null | undefined) {
	return value ? normalizeProjectName(value) : null;
}

function proposalPairScore(expected: ExpectedProposal, predicted: ExtractedTask) {
	const expectedSources = new Set(expected.sourceMessageIds);
	const sharedSources = [...new Set(predicted.source_message_ids)].filter(id => expectedSources.has(id)).length;
	const content = `${predicted.title}\n${predicted.description}`.toLocaleLowerCase();
	const matchedTitleConcepts = expected.titleIncludes.filter(term => content.includes(term.toLocaleLowerCase())).length;
	if (!sharedSources && !matchedTitleConcepts) return undefined;
	return (sharedSources * 100) + matchedTitleConcepts;
}

function alignedProposalPairs(expected: ExpectedProposal[], predicted: ExtractedTask[]) {
	let best: ProposalPair[] = [];
	let bestScore = -1;
	const visit = (expectedIndex: number, usedPredictions: Set<number>, pairs: ProposalPair[], score: number) => {
		if (expectedIndex === expected.length) {
			if (pairs.length > best.length || (pairs.length === best.length && score > bestScore)) {
				best = [...pairs];
				bestScore = score;
			}
			return;
		}
		visit(expectedIndex + 1, usedPredictions, pairs, score);
		for (let predictedIndex = 0; predictedIndex < predicted.length; predictedIndex++) {
			if (usedPredictions.has(predictedIndex)) continue;
			const pairScore = proposalPairScore(expected[expectedIndex]!, predicted[predictedIndex]!);
			if (pairScore === undefined) continue;
			usedPredictions.add(predictedIndex);
			pairs.push({ expectedIndex, predictedIndex, score: pairScore });
			visit(expectedIndex + 1, usedPredictions, pairs, score + pairScore);
			pairs.pop();
			usedPredictions.delete(predictedIndex);
		}
	};
	visit(0, new Set(), [], 0);
	return best;
}

export function proposalDiagnostics(expected: ExpectedProposal[], predicted: ExtractedTask[]): ProposalDiagnostics {
	const pairs = alignedProposalPairs(expected, predicted);
	const diagnostics: ProposalDiagnostics = {
		alignedProposals: pairs.length,
		detection: { truePositives: pairs.length, falsePositives: predicted.length - pairs.length, falseNegatives: expected.length - pairs.length },
		action: { correct: 0, compared: pairs.length },
		sources: {
			truePositives: 0,
			falsePositives: predicted.reduce((total, proposal) => total + new Set(proposal.source_message_ids).size, 0),
			falseNegatives: expected.reduce((total, proposal) => total + new Set(proposal.sourceMessageIds).size, 0),
		},
		titleConcepts: { matched: 0, expected: expected.reduce((total, proposal) => total + proposal.titleIncludes.length, 0) },
		project: { correct: 0, compared: 0 },
		owner: { correct: 0, compared: 0 },
		deadline: { correct: 0, compared: 0 },
	};
	for (const pair of pairs) {
		const expectedProposal = expected[pair.expectedIndex]!;
		const predictedProposal = predicted[pair.predictedIndex]!;
		if (predictedProposal.proposed_action === expectedProposal.action) diagnostics.action.correct++;
		const expectedSources = new Set(expectedProposal.sourceMessageIds);
		const predictedSources = new Set(predictedProposal.source_message_ids);
		const sharedSources = [...predictedSources].filter(id => expectedSources.has(id)).length;
		diagnostics.sources.truePositives += sharedSources;
		diagnostics.sources.falsePositives -= sharedSources;
		diagnostics.sources.falseNegatives -= sharedSources;
		const content = `${predictedProposal.title}\n${predictedProposal.description}`.toLocaleLowerCase();
		diagnostics.titleConcepts.matched += expectedProposal.titleIncludes.filter(term => content.includes(term.toLocaleLowerCase())).length;
		if (expectedProposal.projectName !== undefined) {
			diagnostics.project.compared++;
			if (normalizedProject(predictedProposal.project_name) === normalizedProject(expectedProposal.projectName)) diagnostics.project.correct++;
		}
		if (expectedProposal.assigneeAlias !== undefined) {
			diagnostics.owner.compared++;
			if (predictedProposal.assignee_alias === expectedProposal.assigneeAlias) diagnostics.owner.correct++;
		}
		if (expectedProposal.dueDate !== undefined) {
			diagnostics.deadline.compared++;
			if (predictedProposal.due_date === expectedProposal.dueDate) diagnostics.deadline.correct++;
		}
	}
	return diagnostics;
}

function addProposalDiagnostics(total: ProposalDiagnostics, diagnostics: ProposalDiagnostics) {
	total.alignedProposals += diagnostics.alignedProposals;
	for (const key of ["truePositives", "falsePositives", "falseNegatives"] as const) total.detection[key] += diagnostics.detection[key];
	for (const key of ["truePositives", "falsePositives", "falseNegatives"] as const) total.sources[key] += diagnostics.sources[key];
	for (const component of ["action", "project", "owner", "deadline"] as const) {
		total[component].correct += diagnostics[component].correct;
		total[component].compared += diagnostics[component].compared;
	}
	total.titleConcepts.matched += diagnostics.titleConcepts.matched;
	total.titleConcepts.expected += diagnostics.titleConcepts.expected;
}

function percent(value: number) {
	return `${(value * 100).toFixed(1)}%`;
}

function sleep(milliseconds: number) {
	return new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));
}

const EVALUATOR_PIPELINE_VERSION = "automatic-v3.6";
const evaluationTraceSchema = z.object({
	extractedCandidates: z.number().int().min(0),
	referenceValidCandidates: z.number().int().min(0),
	groundedCandidates: z.number().int().min(0),
	finalCandidates: z.number().int().min(0),
	gateCriteriaFailures: z.object({ activation: z.number().int().min(0), remainingWork: z.number().int().min(0), durability: z.number().int().min(0), decisionReadiness: z.number().int().min(0), sensitivity: z.number().int().min(0) }),
});
const cachedCaseSchema = z.object({
	version: z.literal(EVALUATOR_PIPELINE_VERSION),
	predicted: z.array(z.unknown()),
	trace: evaluationTraceSchema,
});

export function evaluationTrace(extractedCandidates: number, referenceValidCandidates: number, groundedCandidates: number, assessments: AutomaticCandidateAssessment[], finalCandidates: number) {
	return evaluationTraceSchema.parse({
		extractedCandidates,
		referenceValidCandidates,
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
	const diagnosticTotals: ProposalDiagnostics = {
		alignedProposals: 0,
		detection: { truePositives: 0, falsePositives: 0, falseNegatives: 0 },
		action: { correct: 0, compared: 0 },
		sources: { truePositives: 0, falsePositives: 0, falseNegatives: 0 },
		titleConcepts: { matched: 0, expected: 0 },
		project: { correct: 0, compared: 0 },
		owner: { correct: 0, compared: 0 },
		deadline: { correct: 0, compared: 0 },
	};
	const stageTotals = {
		extractedCandidates: 0, referenceValidCandidates: 0, groundedCandidates: 0, finalCandidates: 0,
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
			const referenceValid = runtimeReferenceValidCandidates(extraction.result.tasks, window.messages as MinimizedMessage[]);
			const grounded = mergeRelatedTaskCandidates(referenceValid);
			let assessments: AutomaticCandidateAssessment[] = [];
			let windowSensitivity: "safe" | "sensitive" | "uncertain" = window.mode === "manual" ? "safe" : "uncertain";
			if (window.mode === "automatic" && grounded.length) {
				const waitForGate = Math.max(0, env.AI_EVAL_MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
				if (waitForGate) await sleep(waitForGate);
				lastRequestAt = Date.now();
				const gate = await extractor.assessAutomaticCandidates(extraction.inputMessages, grounded);
				assessments = gate.assessments;
				windowSensitivity = gate.windowSensitivity;
				totalLatencyMs += gate.latencyMs;
				totalTokens += gate.usage?.totalTokens ?? 0;
			}
			predicted = runtimeProposalCandidates(extraction.result.tasks, window.messages as MinimizedMessage[], window.routing, window.mode, assessments, windowSensitivity);
			trace = evaluationTrace(extraction.result.tasks.length, referenceValid.length, grounded.length, assessments, predicted.length);
			await storePrediction(env.AI_EVAL_CACHE_DIR, item.key, predicted, trace);
			validOutputs++;
			}
			stageTotals.extractedCandidates += trace.extractedCandidates;
			stageTotals.referenceValidCandidates += trace.referenceValidCandidates;
			stageTotals.groundedCandidates += trace.groundedCandidates;
			stageTotals.finalCandidates += trace.finalCandidates;
			for (const key of Object.keys(stageTotals.gateCriteriaFailures) as Array<keyof typeof stageTotals.gateCriteriaFailures>) {
				stageTotals.gateCriteriaFailures[key] += trace.gateCriteriaFailures[key];
			}
			const diagnostics = proposalDiagnostics(window.expected.proposals, predicted);
			addProposalDiagnostics(diagnosticTotals, diagnostics);
			const unmatched = new Set(predicted.map((_, index) => index));
			let matched = 0;
			for (const expected of window.expected.proposals) {
				const index = [...unmatched].find(candidateIndex => {
					const candidate = predicted[candidateIndex];
					if (!candidate || candidate.proposed_action !== expected.action || !sameSet(candidate.source_message_ids, expected.sourceMessageIds)) return false;
					if (expected.projectName !== undefined && normalizedProject(candidate.project_name) !== normalizedProject(expected.projectName)) return false;
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
			cases.push({ id: window.id, expectedProposals: window.expected.proposals.length, predictedProposals: predicted.length, matchedProposals: matched, validOutput: true, cached: Boolean(item.cached), trace, diagnostics });
		} catch (error) {
			if (error instanceof StructuredOutputError) invalidOutputs++;
			else {
				providerErrors++;
				const category = providerFailureCategory(error);
				providerErrorCategories[category] = (providerErrorCategories[category] ?? 0) + 1;
			}
			const diagnostics = proposalDiagnostics(window.expected.proposals, []);
			addProposalDiagnostics(diagnosticTotals, diagnostics);
			falseNegatives += window.expected.proposals.length;
			cases.push({ id: window.id, expectedProposals: window.expected.proposals.length, predictedProposals: 0, matchedProposals: 0, validOutput: false, errorType: providerFailureCategory(error), diagnostics });
		}
	}
	const stageDiagnostics = {
		groundingRejections: Math.max(0, stageTotals.extractedCandidates - stageTotals.referenceValidCandidates),
		candidateMerges: Math.max(0, stageTotals.referenceValidCandidates - stageTotals.groundedCandidates),
		finalizationRejections: Math.max(0, stageTotals.groundedCandidates - stageTotals.finalCandidates),
		groundingRetention: optionalRatio(stageTotals.referenceValidCandidates, stageTotals.extractedCandidates),
		mergeRetention: optionalRatio(stageTotals.groundedCandidates, stageTotals.referenceValidCandidates),
		finalizationRetention: optionalRatio(stageTotals.finalCandidates, stageTotals.groundedCandidates),
	};

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
		diagnostics: {
			detectionPrecision: ratio(diagnosticTotals.detection.truePositives, diagnosticTotals.detection.truePositives + diagnosticTotals.detection.falsePositives),
			detectionRecall: ratio(diagnosticTotals.detection.truePositives, diagnosticTotals.detection.truePositives + diagnosticTotals.detection.falseNegatives),
			actionAccuracy: optionalRatio(diagnosticTotals.action.correct, diagnosticTotals.action.compared),
			sourcePrecision: optionalRatio(diagnosticTotals.sources.truePositives, diagnosticTotals.sources.truePositives + diagnosticTotals.sources.falsePositives),
			sourceRecall: optionalRatio(diagnosticTotals.sources.truePositives, diagnosticTotals.sources.truePositives + diagnosticTotals.sources.falseNegatives),
			titleConceptRecall: optionalRatio(diagnosticTotals.titleConcepts.matched, diagnosticTotals.titleConcepts.expected),
			projectAccuracy: optionalRatio(diagnosticTotals.project.correct, diagnosticTotals.project.compared),
			ownerAccuracy: optionalRatio(diagnosticTotals.owner.correct, diagnosticTotals.owner.compared),
			deadlineAccuracy: optionalRatio(diagnosticTotals.deadline.correct, diagnosticTotals.deadline.compared),
			counts: diagnosticTotals,
		},
		stageTotals,
		stageDiagnostics,
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
		`| Detection precision | ${validOutputs ? percent(report.diagnostics.detectionPrecision) : "N/A"} | — |`,
		`| Detection recall | ${validOutputs ? percent(report.diagnostics.detectionRecall) : "N/A"} | — |`,
		`| Action accuracy | ${validOutputs && report.diagnostics.actionAccuracy !== null ? percent(report.diagnostics.actionAccuracy) : "N/A"} | — |`,
		`| Source precision | ${validOutputs && report.diagnostics.sourcePrecision !== null ? percent(report.diagnostics.sourcePrecision) : "N/A"} | — |`,
		`| Source recall | ${validOutputs && report.diagnostics.sourceRecall !== null ? percent(report.diagnostics.sourceRecall) : "N/A"} | — |`,
		`| Title concept recall | ${validOutputs && report.diagnostics.titleConceptRecall !== null ? percent(report.diagnostics.titleConceptRecall) : "N/A"} | — |`,
		`| Aligned project accuracy | ${validOutputs && report.diagnostics.projectAccuracy !== null ? percent(report.diagnostics.projectAccuracy) : "N/A"} | — |`,
		`| Aligned owner accuracy | ${validOutputs && report.diagnostics.ownerAccuracy !== null ? percent(report.diagnostics.ownerAccuracy) : "N/A"} | — |`,
		`| Aligned deadline accuracy | ${validOutputs && report.diagnostics.deadlineAccuracy !== null ? percent(report.diagnostics.deadlineAccuracy) : "N/A"} | — |`,
		`| Owner accuracy | ${validOutputs && report.metrics.ownerAccuracy !== null ? percent(report.metrics.ownerAccuracy) : "N/A"} | — |`,
		`| Deadline accuracy | ${validOutputs && report.metrics.deadlineAccuracy !== null ? percent(report.metrics.deadlineAccuracy) : "N/A"} | — |`,
		`| Valid structured output | ${percent(report.metrics.validOutputRate)} | ${percent(thresholds.validOutputRate)} |`,
		`| Average latency | ${Math.round(report.metrics.averageLatencyMs)} ms | — |`,
		`| Total tokens | ${report.metrics.totalTokens} | — |`,
		`| Provider retries | ${report.metrics.providerRetries} | — |`,
		`| Cache hits | ${report.metrics.cacheHits} | — |`,
		"",
		`Pipeline changes: grounding rejections=${stageDiagnostics.groundingRejections}; candidate merges=${stageDiagnostics.candidateMerges}; finalization rejections=${stageDiagnostics.finalizationRejections}.`,
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
