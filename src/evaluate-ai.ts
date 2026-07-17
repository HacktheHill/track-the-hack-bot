import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";
import { AzureTaskExtractor, StructuredOutputError, type MinimizedMessage } from "./azure-openai.js";
import type { IntegrationConfig } from "./config.js";

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
});

const relevanceSchema = z.enum(["relevant", "supporting", "unrelated", "completion", "superseding", "unclear"]);

export const corpusWindowSchema = z.object({
	id: z.string().min(1),
	messages: z.array(messageSchema).min(1),
	metadata: z.object({ priorities: z.array(z.string()).optional(), sizes: z.array(z.string()).optional() }).optional(),
	expected: z.object({
		taskExists: z.boolean(),
		classification: z.string().optional(),
		assigneeAlias: z.string().nullable().optional(),
		dueDate: z.string().nullable().optional(),
		sourceMessageIds: z.array(z.string()).optional(),
		action: z.enum(["create", "update", "complete", "reopen", "no_action"]).optional(),
		completion: z.enum(["incomplete", "completed", "cancelled", "superseded", "unknown"]).optional(),
		relevance: z.record(z.string(), relevanceSchema).optional(),
	}),
});

const envSchema = z.object({
	AZURE_OPENAI_ENDPOINT: z.url(),
	AZURE_OPENAI_DEPLOYMENT: z.string().min(1),
	AZURE_OPENAI_API_VERSION: z.string().default("v1"),
	AZURE_OPENAI_MAX_COMPLETION_TOKENS: z.coerce.number().int().min(64).max(4096).default(1024),
	OPENPROJECT_AI_MAX_CONTEXT_CHARS: z.coerce.number().int().min(2000).max(100000).default(16000),
	OPENPROJECT_AI_MAX_IMAGE_ATTACHMENTS: z.coerce.number().int().min(0).max(20).default(0),
	OPENPROJECT_AI_SIGNIFICANCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
	AI_EVAL_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(60000).default(0),
	AI_EVAL_PROVIDER_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
});

type ExtractedTask = Awaited<ReturnType<AzureTaskExtractor["extract"]>>["result"]["tasks"][number];

export function isRuntimeCreateCandidate(task: ExtractedTask, significanceThreshold: number) {
	return task.proposed_action === "create" &&
		task.completion_state === "incomplete" &&
		task.significance_score >= significanceThreshold &&
		["new_assignment", "clarification", "additional_requirements", "unclear"].includes(task.context_relation);
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
	return new Promise(resolve => setTimeout(resolve, milliseconds));
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
	let trueNegatives = 0;
	let validOutputs = 0;
	let invalidOutputs = 0;
	let providerErrors = 0;
	let classificationCorrect = 0;
	let classificationCompared = 0;
	let ownerCorrect = 0;
	let ownerCompared = 0;
	let deadlineCorrect = 0;
	let deadlineCompared = 0;
	let sourcesCorrect = 0;
	let sourcesCompared = 0;
	let actionCorrect = 0;
	let actionCompared = 0;
	let completionCorrect = 0;
	let completionCompared = 0;
	let relevanceCorrect = 0;
	let relevanceCompared = 0;
	let totalLatencyMs = 0;
	let latencySamples = 0;
	let totalTokens = 0;
	let providerRetries = 0;
	let lastRequestAt = 0;
	const cases: Array<Record<string, unknown>> = [];

	for (const window of windows) {
		try {
			let extraction: Awaited<ReturnType<AzureTaskExtractor["extract"]>> | undefined;
			for (let attempt = 0; attempt <= env.AI_EVAL_PROVIDER_RETRIES; attempt++) {
				const waitFor = Math.max(0, env.AI_EVAL_MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
				if (waitFor) await sleep(waitFor);
				lastRequestAt = Date.now();
				try {
					extraction = await extractor.extract(window.messages as MinimizedMessage[], { metadata: window.metadata });
					break;
				} catch (error) {
					if (error instanceof StructuredOutputError || attempt === env.AI_EVAL_PROVIDER_RETRIES) throw error;
					providerRetries++;
					await sleep(Math.max(env.AI_EVAL_MIN_INTERVAL_MS, 1000) * (attempt + 1));
				}
			}
			if (!extraction) throw new Error("AI evaluation exhausted retries without a result.");
			validOutputs++;
			totalLatencyMs += extraction.latencyMs;
			latencySamples++;
			totalTokens += extraction.usage?.totalTokens ?? 0;
			const predicted = extraction.result.tasks.find(task => isRuntimeCreateCandidate(task, env.OPENPROJECT_AI_SIGNIFICANCE_THRESHOLD));
			const evaluatedTask = predicted ?? extraction.result.tasks[0];
			const predictedExists = Boolean(predicted);
			if (window.expected.taskExists && predictedExists) truePositives++;
			else if (!window.expected.taskExists && predictedExists) falsePositives++;
			else if (window.expected.taskExists) falseNegatives++;
			else trueNegatives++;
			if (window.expected.classification !== undefined && predicted) {
				classificationCompared++;
				if (predicted.classification === window.expected.classification) classificationCorrect++;
			}
			if (window.expected.assigneeAlias !== undefined && predicted) {
				ownerCompared++;
				if (predicted.assignee_alias === window.expected.assigneeAlias) ownerCorrect++;
			}
			if (window.expected.dueDate !== undefined && predicted) {
				deadlineCompared++;
				if (predicted.due_date === window.expected.dueDate) deadlineCorrect++;
			}
			if (window.expected.sourceMessageIds !== undefined && predicted) {
				sourcesCompared++;
				if (sameSet(predicted.source_message_ids, window.expected.sourceMessageIds)) sourcesCorrect++;
			}
			if (window.expected.action !== undefined) {
				actionCompared++;
				if (evaluatedTask?.proposed_action === window.expected.action) actionCorrect++;
			}
			if (window.expected.completion !== undefined) {
				completionCompared++;
				if (evaluatedTask?.completion_state === window.expected.completion) completionCorrect++;
			}
			const assessments = new Map(extraction.result.message_assessments.map(item => [item.message_id, item.relevance]));
			for (const [messageId, expectedRelevance] of Object.entries(window.expected.relevance ?? {})) {
				relevanceCompared++;
				if (assessments.get(messageId) === expectedRelevance) relevanceCorrect++;
			}
			cases.push({ id: window.id, expectedTask: window.expected.taskExists, predictedTask: predictedExists, validOutput: true });
		} catch (error) {
			if (error instanceof StructuredOutputError) invalidOutputs++;
			else providerErrors++;
			cases.push({ id: window.id, expectedTask: window.expected.taskExists, predictedTask: false, validOutput: false, errorType: error instanceof StructuredOutputError ? "invalid_output" : "provider_error" });
		}
	}

	const report = {
		generatedAt: new Date().toISOString(),
		corpusWindows: windows.length,
		model: env.AZURE_OPENAI_DEPLOYMENT,
		metrics: {
			taskPrecision: ratio(truePositives, truePositives + falsePositives),
			taskRecall: ratio(truePositives, truePositives + falseNegatives),
			falsePositiveRate: ratio(falsePositives, falsePositives + trueNegatives),
			classificationAccuracy: ratio(classificationCorrect, classificationCompared),
			ownerAccuracy: ratio(ownerCorrect, ownerCompared),
			deadlineAccuracy: ratio(deadlineCorrect, deadlineCompared),
			sourceIdAccuracy: ratio(sourcesCorrect, sourcesCompared),
			actionAccuracy: ratio(actionCorrect, actionCompared),
			completionAccuracy: ratio(completionCorrect, completionCompared),
			messageRelevanceAccuracy: ratio(relevanceCorrect, relevanceCompared),
			validOutputRate: ratio(validOutputs, windows.length),
			averageLatencyMs: ratio(totalLatencyMs, latencySamples),
			totalTokens,
			invalidOutputs,
			providerErrors,
			providerRetries,
		},
		counts: { truePositives, falsePositives, falseNegatives, trueNegatives },
		targets: { taskPrecision: 0.95, ownerAccuracy: 0.90, deadlineAccuracy: 0.90, validOutputRate: 0.99 },
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
		`| Task precision | ${percent(report.metrics.taskPrecision)} | 95% |`,
		`| Task recall | ${percent(report.metrics.taskRecall)} | — |`,
		`| False-positive rate | ${percent(report.metrics.falsePositiveRate)} | — |`,
		`| Classification accuracy | ${percent(report.metrics.classificationAccuracy)} | — |`,
		`| Owner accuracy | ${percent(report.metrics.ownerAccuracy)} | 90% |`,
		`| Deadline accuracy | ${percent(report.metrics.deadlineAccuracy)} | 90% |`,
		`| Source-ID accuracy | ${percent(report.metrics.sourceIdAccuracy)} | — |`,
		`| Action accuracy | ${percent(report.metrics.actionAccuracy)} | — |`,
		`| Completion accuracy | ${percent(report.metrics.completionAccuracy)} | — |`,
		`| Message relevance accuracy | ${percent(report.metrics.messageRelevanceAccuracy)} | — |`,
		`| Valid structured output | ${percent(report.metrics.validOutputRate)} | 99% |`,
		`| Average latency | ${Math.round(report.metrics.averageLatencyMs)} ms | — |`,
		`| Total tokens | ${report.metrics.totalTokens} | — |`,
		`| Provider retries | ${report.metrics.providerRetries} | — |`,
		"",
		`Invalid outputs: ${invalidOutputs}; provider errors: ${providerErrors}.`,
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
