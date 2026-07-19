import "dotenv/config";
import pg from "pg";
import { z } from "zod";
import { AzureTaskExtractor, SensitiveContentError, type MinimizedMessage } from "./azure-openai.js";
import type { IntegrationConfig } from "./config.js";

const { Pool } = pg;
const replayConfigSchema = z.object({
	DATABASE_URL: z.string().min(1),
	AZURE_OPENAI_ENDPOINT: z.url(),
	AZURE_OPENAI_DEPLOYMENT: z.string().min(1),
	AZURE_OPENAI_API_VERSION: z.string().default("v1"),
	AZURE_OPENAI_MAX_COMPLETION_TOKENS: z.coerce.number().int().min(64).max(4096).default(4096),
	OPENPROJECT_AI_MAX_CONTEXT_CHARS: z.coerce.number().int().min(2000).max(100000).default(16000),
	OPENPROJECT_AI_MAX_IMAGE_ATTACHMENTS: z.coerce.number().int().min(0).max(20).default(8),
	AI_REPLAY_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(60000).default(8000),
});

function eventIds(value?: string) {
	if (!value) throw new Error("Usage: node dist/replay-ai.js <comma-separated-extraction-event-ids>");
	const ids = value.split(",").map(id => Number(id.trim()));
	if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error("Extraction event IDs must be positive integers.");
	return ids;
}

async function main() {
	const config = replayConfigSchema.parse(process.env);
	const ids = eventIds(process.argv[2]);
	const pool = new Pool({ connectionString: config.DATABASE_URL, max: 1 });
	try {
		const result = await pool.query<{
			id: string;
			source: "manual" | "automatic";
			outcome: string;
			trigger_id: string | null;
			input_snapshot: MinimizedMessage[] | null;
			decision: {
				extractionMetadata?: { priorities?: string[]; sizes?: string[] };
				extractionOptions?: { allowSensitiveContent?: boolean };
			} | null;
		}>(
			`SELECT id,source,outcome,trigger_id,input_snapshot,decision
			 FROM ai_extraction_events WHERE id = ANY($1::bigint[]) ORDER BY id`,
			[ids],
		);
		const returnedIds = new Set(result.rows.map(row => Number(row.id)));
		const missingIds = ids.filter(id => !returnedIds.has(id));
		if (missingIds.length) throw new Error(`Extraction events were not found: ${missingIds.join(", ")}`);
		const extractor = new AzureTaskExtractor(config as unknown as IntegrationConfig);
		for (const row of result.rows) {
			if (!row.input_snapshot?.length) {
				console.log(JSON.stringify({ id: row.id, source: row.source, originalOutcome: row.outcome, skipped: "no_snapshot" }));
				continue;
			}
			const messages = row.input_snapshot.map(message => ({
				...message,
				priority: message.priority ?? message.id === row.trigger_id,
			}));
			const fidelity = row.decision?.extractionMetadata ? "exact_minimized_input" : "legacy_text_snapshot";
			if (fidelity === "legacy_text_snapshot") {
				console.error(`Event ${row.id} predates exact input capture; attachments, reply context, and extraction metadata may be unavailable.`);
			}
			try {
				const extraction = await extractor.extract(messages, {
					mode: row.source,
					metadata: row.decision?.extractionMetadata,
					allowSensitiveContent: row.decision?.extractionOptions?.allowSensitiveContent,
				});
				console.log(JSON.stringify({
					id: row.id,
					source: row.source,
					originalOutcome: row.outcome,
					fidelity,
					candidates: extraction.result.tasks.map(task => ({
						title: task.title,
						action: task.proposed_action,
						automaticEligibility: task.automatic_eligibility,
						triggerKind: task.trigger_kind,
						lifecycle: task.lifecycle,
						sourceMessageIds: task.source_message_ids,
					})),
				}));
			} catch (error) {
				console.log(JSON.stringify({
					id: row.id,
					source: row.source,
					originalOutcome: row.outcome,
					fidelity,
					reproducedError: error instanceof SensitiveContentError ? "sensitive_block" : error instanceof Error ? error.name : "unknown",
				}));
			}
			await new Promise(resolve => setTimeout(resolve, config.AI_REPLAY_MIN_INTERVAL_MS));
		}
	} finally {
		await pool.end();
	}
}

main().catch(error => {
	console.error((error as Error).message);
	process.exitCode = 1;
});
