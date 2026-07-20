import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";
import { automaticCandidateEligible, AzureTaskExtractor, mergeRelatedTaskCandidates, StructuredOutputError, type AutomaticCandidateAssessment, type ExtractedTasks, type MinimizedMessage } from "./azure-openai.js";
import type { IntegrationConfig } from "./config.js";
import { resolveProposedAction } from "./rag.js";
import { taskReferencesAreValid } from "./task-proposals.js";

loadDotEnv();

const messageSchema = z.object({
	id: z.string().min(1),
	channelId: z.string().optional(),
	authorAlias: z.string().min(1),
	text: z.string(),
	timestamp: z.iso.datetime(),
	replyTo: z.string().optional(),
	contextRole: z.enum(["primary", "preceding", "subsequent", "thread_root", "reply_target", "referenced_history"]).optional(),
	priority: z.boolean().optional(),
	attachments: z.array(z.object({ id: z.string(), name: z.string(), contentType: z.string().optional(), url: z.url() })).optional(),
});

const expectedProposalSchema = z.object({
	action: z.enum(["create", "update", "complete", "reopen"]),
	titleIncludes: z.array(z.string().min(1)).min(1),
	assigneeAlias: z.string().nullable().optional(),
	dueDate: z.string().nullable().optional(),
	sourceMessageIds: z.array(z.string()).min(1),
});

export const corpusWindowSchema = z.object({
	id: z.string().min(1),
	mode: z.enum(["manual", "automatic"]),
	messages: z.array(messageSchema).min(1),
	metadata: z.object({ priorities: z.array(z.string()).optional(), sizes: z.array(z.string()).optional() }).optional(),
	routing: z.object({ availableTargetSourceMessageIds: z.array(z.array(z.string()).min(1)).default([]) }).optional(),
	expected: z.object({ proposals: z.array(expectedProposalSchema).max(5) }),
}).superRefine((window, context) => {
	const focal = window.messages.filter(message => message.contextRole === "primary" || message.priority);
	if (window.mode === "automatic" && focal.length !== 1) {
		context.addIssue({ code: "custom", message: "Automatic evaluation windows require exactly one primary or priority focal message." });
	}
	if (window.mode === "manual" && !focal.length) {
		context.addIssue({ code: "custom", message: "Manual evaluation windows require at least one primary or priority focal message." });
	}
});

const envSchema = z.object({
	AZURE_OPENAI_ENDPOINT: z.url(),
	AZURE_OPENAI_DEPLOYMENT: z.string().min(1),
	AZURE_OPENAI_API_VERSION: z.string().default("v1"),
	AZURE_OPENAI_MAX_COMPLETION_TOKENS: z.coerce.number().int().min(64).max(4096).default(4096),
	OPENPROJECT_AI_MAX_CONTEXT_CHARS: z.coerce.number().int().min(2000).max(100000).default(16000),
	OPENPROJECT_AI_MAX_IMAGE_ATTACHMENTS: z.coerce.number().int().min(0).max(20).default(0),
	AI_EVAL_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(60000).default(0),
	AI_EVAL_PROVIDER_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
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

function sameSet(left: string[], right: string[]) {
	return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function percent(value: number) {
	return `${(value * 100).toFixed(1)}%`;
}

function sleep(milliseconds: number) {
	return new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));
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

async function main() {
	const inputPath = process.argv[2];
	if (!inputPath) throw new Error("Usage: npm run evaluate:ai -- <private-corpus.jsonl> [output-prefix]");
	const absoluteInput = resolve(inputPath);
	const outputPrefix = resolve(process.argv[3] ?? `${absoluteInput}.report`);
	const windows = (await readFile(absoluteInput, "utf8"))
		.split(/\r?\n/)
		.filter(line => line.trim())
		.map((line, index) => {
			try { return corpusWindowSchema.parse(JSON.parse(line)); }
			catch (error) { throw new Error(`Invalid corpus line ${index + 1}: ${(error as Error).message}`); }
		});
	const env = envSchema.parse(process.env);
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
	let lastRequestAt = 0;
	const providerErrorCategories: Record<string, number> = {};
	const cases: Array<Record<string, unknown>> = [];

	for (const window of windows) {
		try {
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
			validOutputs++;
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
			const predicted = runtimeProposalCandidates(extraction.result.tasks, window.messages as MinimizedMessage[], window.routing, window.mode, assessments);
			const unmatched = new Set(predicted.map((_, index) => index));
			let matched = 0;
			for (const expected of window.expected.proposals) {
				const index = [...unmatched].find(candidateIndex => {
					const candidate = predicted[candidateIndex];
					if (!candidate || candidate.proposed_action !== expected.action || !sameSet(candidate.source_message_ids, expected.sourceMessageIds)) return false;
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
			cases.push({ id: window.id, expectedProposals: window.expected.proposals.length, predictedProposals: predicted.length, matchedProposals: matched, validOutput: true });
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

	const report = {
		generatedAt: new Date().toISOString(),
		corpusWindows: windows.length,
		model: env.AZURE_OPENAI_DEPLOYMENT,
		metrics: {
			proposalPrecision: ratio(truePositives, truePositives + falsePositives),
			proposalRecall: ratio(truePositives, truePositives + falseNegatives),
			ownerAccuracy: ratio(ownerCorrect, ownerCompared),
			deadlineAccuracy: ratio(deadlineCorrect, deadlineCompared),
			validOutputRate: ratio(validOutputs, windows.length),
			averageLatencyMs: ratio(totalLatencyMs, latencySamples),
			totalTokens,
			invalidOutputs,
			providerErrors,
			providerRetries,
		},
		counts: { truePositives, falsePositives, falseNegatives },
		providerErrorCategories,
		targets: { proposalPrecision: 0.95, ownerAccuracy: 0.90, deadlineAccuracy: 0.90, validOutputRate: 0.99 },
		cases,
	};
	const markdown = [
		"# AI task extraction evaluation",
		"",
		`Generated: ${report.generatedAt}`,
		`Model: ${report.model}`,
		`Corpus windows: ${report.corpusWindows}`,
		"",
		"| Metric | Result | Target |",
		"| --- | ---: | ---: |",
		`| Proposal precision | ${validOutputs ? percent(report.metrics.proposalPrecision) : "N/A"} | 95% |`,
		`| Proposal recall | ${validOutputs ? percent(report.metrics.proposalRecall) : "N/A"} | — |`,
		`| Owner accuracy | ${validOutputs ? percent(report.metrics.ownerAccuracy) : "N/A"} | 90% |`,
		`| Deadline accuracy | ${validOutputs ? percent(report.metrics.deadlineAccuracy) : "N/A"} | 90% |`,
		`| Valid structured output | ${percent(report.metrics.validOutputRate)} | 99% |`,
		`| Average latency | ${Math.round(report.metrics.averageLatencyMs)} ms | — |`,
		`| Total tokens | ${report.metrics.totalTokens} | — |`,
		`| Provider retries | ${report.metrics.providerRetries} | — |`,
		"",
		`Invalid outputs: ${invalidOutputs}; provider errors: ${providerErrors}.`,
		providerErrors ? `Provider error categories: ${Object.entries(providerErrorCategories).map(([category, count]) => `${category}=${count}`).join(", ")}.` : "",
		!validOutputs ? "\n> Evaluation incomplete: no valid model outputs were produced. Quality metrics are unavailable; fix provider access before using this report for a rollout decision." : "",
		windows.length < 100 ? "\n> Warning: this corpus has fewer than the planned 100 representative windows." : "",
	].join("\n");
	await writeFile(`${outputPrefix}.json`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
	await writeFile(`${outputPrefix}.md`, `${markdown}\n`, { mode: 0o600 });
	console.log(markdown);
	console.log(`\nReports written to ${outputPrefix}.json and ${outputPrefix}.md`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch(error => {
		console.error((error as Error).message);
		process.exitCode = 1;
	});
}
