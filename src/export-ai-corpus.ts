import "dotenv/config";
import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { z } from "zod";
import { corpusWindowSchema, sanitizeCorpusWindow } from "./ai-corpus.js";

const { Pool } = pg;

const configSchema = z.object({
	DATABASE_URL: z.string().min(1),
});

export const exportRowSchema = z.object({
	id: z.coerce.string(),
	source: z.enum(["manual", "automatic"]),
	input_snapshot: z.array(z.object({
		id: z.string(),
		channelId: z.string().optional(),
		authorAlias: z.string(),
		text: z.string(),
		timestamp: z.string(),
		contextRole: z.enum(["primary", "preceding", "subsequent", "thread_root", "reply_target", "referenced_history"]).optional(),
		priority: z.boolean().optional(),
		replyTo: z.string().optional(),
		attachments: z.array(z.object({ id: z.string(), name: z.string(), contentType: z.string().optional(), url: z.string() })).optional(),
	})),
	message_assessments: z.array(z.record(z.string(), z.unknown())).nullable(),
	decision: z.record(z.string(), z.unknown()).nullable(),
	proposals: z.array(z.object({
		status: z.string(),
		reviewOutcome: z.string().nullable(),
		dismissalReason: z.string().nullable(),
		action: z.enum(["create", "update", "complete", "reopen"]),
		targetWorkPackageId: z.number().int().nullable(),
		title: z.string(),
		sourceMessageIds: z.array(z.string()),
		initialSnapshot: z.record(z.string(), z.unknown()).nullable(),
		finalSnapshot: z.record(z.string(), z.unknown()).nullable(),
	})),
});

export type ExportRow = z.infer<typeof exportRowSchema>;

const negativeDismissalReasons = new Set([
	"not_actionable",
	"question_or_announcement",
	"already_completed",
	"not_worth_tracking",
]);

const titleStopWords = new Set([
	"a", "an", "and", "for", "in", "of", "on", "the", "to", "with",
	"add", "create", "make", "prepare", "update", "revise", "complete",
]);

export function evaluationTitleTerms(title: string) {
	const words = title.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	const meaningful = [...new Set(words.filter(word => word.length >= 3 && !titleStopWords.has(word)))];
	return (meaningful.length ? meaningful : words).slice(0, 3);
}

function stringValue(value: unknown) {
	return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function rowAssessments(row: ExportRow) {
	return row.message_assessments ?? (Array.isArray(row.decision?.candidateAssessments) ? row.decision.candidateAssessments : []);
}

function candidateAssessment(row: ExportRow, sourceMessageIds: string[]) {
	const assessments = rowAssessments(row);
	if (!Array.isArray(assessments)) return undefined;
	const expectedIds = [...sourceMessageIds].sort();
	const matching = assessments.find(assessment => {
		if (!assessment || typeof assessment !== "object" || !("sourceMessageIds" in assessment) || !Array.isArray(assessment.sourceMessageIds)) return false;
		const ids: string[] = assessment.sourceMessageIds.filter((id: unknown): id is string => typeof id === "string").sort();
		return ids.length === expectedIds.length && ids.every((id, index) => id === expectedIds[index]);
	});
	return matching && typeof matching === "object" ? matching : undefined;
}

function candidateAction(row: ExportRow, sourceMessageIds: string[]) {
	const assessment = candidateAssessment(row, sourceMessageIds);
	return assessment && "proposedAction" in assessment ? z.enum(["create", "update", "complete", "reopen"]).safeParse(assessment.proposedAction).data : undefined;
}

export function buildCorpusWindow(input: ExportRow) {
	const row = exportRowSchema.parse(input);
	if (!row.input_snapshot.length || !row.proposals.length) return undefined;
	if (row.source === "manual" && row.decision?.groupedCount !== 1) return undefined;
	const extractionOptions = row.decision?.extractionOptions;
	if (extractionOptions && typeof extractionOptions === "object" && "allowSensitiveContent" in extractionOptions && extractionOptions.allowSensitiveContent === true) return undefined;
	const assessments = rowAssessments(row);
	if (!assessments.length || assessments.some(assessment => !assessment || typeof assessment !== "object" || !("sensitivity" in assessment) || assessment.sensitivity !== "safe")) return undefined;
	const messageIds = new Map(row.input_snapshot.map((message, index) => [message.id, `m${index + 1}`]));
	const attachmentIds = new Map(row.input_snapshot.flatMap(message => (message.attachments ?? []).map(attachment => `${message.id}:${attachment.id}`))
		.map((id, index) => [id, `a${index + 1}`]));
	const messages = row.input_snapshot.map(message => ({
		id: messageIds.get(message.id)!,
		authorAlias: message.authorAlias,
		text: message.text,
		timestamp: message.timestamp,
		...(message.contextRole ? { contextRole: message.contextRole } : {}),
		...(message.priority ? { priority: true } : {}),
		...(message.replyTo && messageIds.has(message.replyTo) ? { replyTo: messageIds.get(message.replyTo) } : {}),
		...(message.attachments?.length ? { attachments: message.attachments.map(attachment => ({
			id: attachmentIds.get(`${message.id}:${attachment.id}`)!,
			name: attachment.name,
			...(attachment.contentType ? { contentType: attachment.contentType } : {}),
			url: `https://example.invalid/attachment/${attachmentIds.get(`${message.id}:${attachment.id}`)}`,
		})) } : {}),
	}));
	const expected = [];
	const routingTargets: string[][] = [];
	const relevantMessageIds = new Set<string>();
	for (const proposal of row.proposals) {
		if (proposal.status === "dismissed") {
			if (!proposal.dismissalReason || !negativeDismissalReasons.has(proposal.dismissalReason)) return undefined;
			const assessment = candidateAssessment(row, proposal.sourceMessageIds);
			if (!assessment || candidateAction(row, proposal.sourceMessageIds) !== proposal.action) return undefined;
			proposal.sourceMessageIds.forEach(id => relevantMessageIds.add(id));
			if (Array.isArray(assessment.supporting_source_message_ids)) assessment.supporting_source_message_ids.forEach((id: unknown) => typeof id === "string" && relevantMessageIds.add(id));
			continue;
		}
		if (proposal.status !== "created") return undefined;
		if (!proposal.initialSnapshot || !proposal.finalSnapshot) return undefined;
		const snapshot = proposal.finalSnapshot;
		const initialAction = z.enum(["create", "update", "complete", "reopen"]).catch(proposal.action).parse(proposal.initialSnapshot.action);
		const action = z.enum(["create", "update", "complete", "reopen"]).catch(initialAction).parse(snapshot.action);
		if (action !== initialAction) return undefined;
		const title = stringValue(snapshot.title) ?? proposal.title;
		const rawSourceIds = Array.isArray(snapshot.sourceMessageIds)
			? snapshot.sourceMessageIds.filter((id): id is string => typeof id === "string")
			: proposal.sourceMessageIds;
		if (candidateAction(row, rawSourceIds) !== initialAction) return undefined;
		const sourceMessageIds = rawSourceIds.map(id => messageIds.get(id)).filter((id): id is string => Boolean(id));
		if (!sourceMessageIds.length || sourceMessageIds.length !== rawSourceIds.length) return undefined;
		rawSourceIds.forEach(id => relevantMessageIds.add(id));
		const assessment = candidateAssessment(row, rawSourceIds);
		if (assessment && Array.isArray(assessment.supporting_source_message_ids)) assessment.supporting_source_message_ids.forEach((id: unknown) => typeof id === "string" && relevantMessageIds.add(id));
		expected.push({
			action,
			titleIncludes: evaluationTitleTerms(title),
			sourceMessageIds,
		});
		const targetWorkPackageId = numberValue(snapshot.targetWorkPackageId) ?? proposal.targetWorkPackageId ?? undefined;
		if (action !== "create" && !targetWorkPackageId) return undefined;
		if (action !== "create" && targetWorkPackageId) routingTargets.push(sourceMessageIds);
	}
	const metadata = row.decision?.extractionMetadata;
	const window = corpusWindowSchema.safeParse({
		id: `review-${row.id}`,
		mode: "automatic",
		messages: messages.filter((_, index) => relevantMessageIds.has(row.input_snapshot[index]!.id)),
		...(metadata && typeof metadata === "object" ? { metadata } : {}),
		...(routingTargets.length ? { routing: { availableTargetSourceMessageIds: routingTargets } } : {}),
		expected: { proposals: expected },
	});
	return window.success ? sanitizeCorpusWindow(window.data) : undefined;
}

export async function loadReviewedExtractionRows(pool: Pick<pg.Pool, "query">, days: number) {
	const result = await pool.query(
		`SELECT e.id,e.source,e.input_snapshot,e.message_assessments,e.decision,
			jsonb_agg(jsonb_build_object(
				'status',p.status,
				'reviewOutcome',p.review_outcome,
				'dismissalReason',p.dismissal_reason,
				'action',p.action,
				'targetWorkPackageId',p.target_work_package_id,
				'title',p.title,
				'sourceMessageIds',p.source_message_ids,
				'initialSnapshot',initial_revision.payload,
				'finalSnapshot',final_revision.payload
			) ORDER BY p.created_at,p.id) AS proposals
		 FROM ai_extraction_events e
		 JOIN task_proposal_extractions link ON link.extraction_event_id=e.id
		 JOIN task_proposals p ON p.id=link.proposal_id
		 LEFT JOIN LATERAL (
			SELECT payload FROM task_proposal_revisions
			WHERE proposal_id=p.id AND phase='initial' ORDER BY revision ASC LIMIT 1
		 ) initial_revision ON TRUE
		 LEFT JOIN LATERAL (
			SELECT payload FROM task_proposal_revisions
			WHERE proposal_id=p.id AND phase='final' ORDER BY revision DESC LIMIT 1
		 ) final_revision ON TRUE
		 WHERE e.schema_version='v3' AND e.input_snapshot IS NOT NULL
		 AND e.created_at >= now() - ($1::text || ' days')::interval
		 AND NOT EXISTS (
			SELECT 1 FROM task_proposal_extractions event_link
			JOIN task_proposal_extractions newer ON newer.proposal_id=event_link.proposal_id
			AND newer.extraction_event_id > event_link.extraction_event_id
			WHERE event_link.extraction_event_id=e.id
		 )
		 GROUP BY e.id,e.source,e.input_snapshot,e.message_assessments,e.decision
		 ORDER BY e.id`,
		[days],
	);
	return result.rows.map(row => exportRowSchema.parse(row));
}

async function main() {
	const outputPath = process.argv[2];
	if (!outputPath) throw new Error("Usage: npm run export:ai-corpus -- <private-output.jsonl> [retention-days]");
	const days = Number(process.argv[3] ?? 90);
	if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("Retention days must be an integer from 1 to 3650.");
	const config = configSchema.parse(process.env);
	const pool = new Pool({ connectionString: config.DATABASE_URL, max: 1 });
	try {
		const rows = await loadReviewedExtractionRows(pool, days);
		const windows = rows.map(row => buildCorpusWindow(row)).filter(window => window !== undefined);
		const output = windows.map(window => JSON.stringify(window)).join("\n");
		const absoluteOutputPath = resolve(outputPath);
		await chmod(absoluteOutputPath, 0o600).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		await writeFile(absoluteOutputPath, output ? `${output}\n` : "", { mode: 0o600 });
		console.log(JSON.stringify({ reviewedExtractionEvents: rows.length, exportedWindows: windows.length, excludedWindows: rows.length - windows.length }));
	} finally {
		await pool.end();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch(error => {
		console.error((error as Error).message);
		process.exitCode = 1;
	});
}
