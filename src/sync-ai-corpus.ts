import "dotenv/config";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { AzureBlobCorpusStore } from "./ai-corpus-blob.js";
import { contentHash, corpusCaseSchema, corpusWindowSchema, sanitizeCorpusCase, sanitizeCorpusWindow, type CorpusCase, type CorpusWindow } from "./ai-corpus.js";
import { loadAiCorpusConfig } from "./ai-corpus-config.js";
import { buildCorpusWindow, buildPendingCorrectionWindow, loadReviewedExtractionRows } from "./export-ai-corpus.js";

const { Pool } = pg;
const databaseConfigSchema = z.object({ DATABASE_URL: z.string().min(1), ORGANIZER_GUILD_ID: z.string().regex(/^\d+$/) });
const discordSnapshotSchema = z.array(z.object({ id: z.string(), channelId: z.string().optional() }));

function caseFromWindow(window: CorpusWindow, origin: CorpusCase["origin"], reviewContext?: CorpusCase["reviewContext"]): CorpusCase {
	const now = new Date().toISOString();
	return corpusCaseSchema.parse({
		schemaVersion: "v2",
		id: window.id,
		origin,
		window,
		...(reviewContext ? { reviewContext } : {}),
		adjudication: { status: "pending", exclusionReasons: [], notes: "" },
		createdAt: now,
		updatedAt: now,
	});
}

export function discordReviewContext(inputSnapshot: Array<{ id: string; channelId?: string }>, window: CorpusWindow, guildId: string): CorpusCase["reviewContext"] | undefined {
	const visibleIds = new Set(window.messages.map(message => message.id));
	const discordMessages = Object.fromEntries(inputSnapshot.flatMap((message, index) => {
		const id = `m${index + 1}`;
		if (!visibleIds.has(id) || !message.channelId) return [];
		return [[id, {
			guildId,
			channelId: message.channelId,
			messageId: message.id,
			url: `https://discord.com/channels/${guildId}/${message.channelId}/${message.id}`,
		}]];
	}));
	return Object.keys(discordMessages).length ? { discordMessages } : undefined;
}

function noTaskWindow(row: { id: string; input_snapshot: unknown }) {
	const snapshot = z.array(z.object({
		id: z.string(), authorAlias: z.string(), text: z.string(), timestamp: z.string(),
		contextRole: z.string().optional(), priority: z.boolean().optional(), replyTo: z.string().optional(),
	})).safeParse(row.input_snapshot);
	if (!snapshot.success || !snapshot.data.length) return undefined;
	const ids = new Map(snapshot.data.map((message, index) => [message.id, `m${index + 1}`]));
	const window = corpusWindowSchema.safeParse({
		id: `no-task-${row.id}`,
		mode: "automatic",
		messages: snapshot.data.map(message => ({
			id: ids.get(message.id), authorAlias: message.authorAlias, text: message.text, timestamp: message.timestamp,
			...(message.contextRole ? { contextRole: message.contextRole } : {}),
			...(message.priority ? { priority: true } : {}),
			...(message.replyTo && ids.has(message.replyTo) ? { replyTo: ids.get(message.replyTo) } : {}),
		})),
		expected: { proposals: [] },
	}).data;
	return window ? sanitizeCorpusWindow(window) : undefined;
}

export async function reconcileCase(store: Pick<AzureBlobCorpusStore, "getCase" | "putCase">, value: CorpusCase) {
	try {
		const existing = await store.getCase(value.id);
		const sourceChanged = existing.case.origin.fingerprint !== value.origin.fingerprint;
		const reconstructedIds = new Set(existing.case.reviewContext?.reconstruction?.addedMessageIds ?? []);
		const validMessageIds = new Set(existing.case.window.messages.map(message => message.id));
		const reconstructedDiscordMessages = Object.fromEntries(Object.entries(existing.case.reviewContext?.discordMessages ?? {})
			.filter(([id]) => reconstructedIds.has(id) && validMessageIds.has(id)));
		const discordMessages = { ...reconstructedDiscordMessages, ...(value.reviewContext?.discordMessages ?? {}) };
		const mergedReviewContext = Object.keys(discordMessages).length || existing.case.reviewContext?.reconstruction
			? {
				discordMessages,
				...(existing.case.reviewContext?.reconstruction ? { reconstruction: existing.case.reviewContext.reconstruction } : {}),
			}
			: undefined;
		const reviewContextChanged = contentHash(existing.case.reviewContext ?? null) !== contentHash(mergedReviewContext ?? null);
		if (!sourceChanged && !reviewContextChanged) return "unchanged" as const;
		await store.putCase(sourceChanged ? {
			...value,
			adjudication: { status: "pending", exclusionReasons: [], notes: existing.case.adjudication.notes },
			createdAt: existing.case.createdAt,
			updatedAt: new Date().toISOString(),
		} : {
			...existing.case,
			reviewContext: mergedReviewContext,
			updatedAt: new Date().toISOString(),
		}, existing.etag);
		return "updated" as const;
	} catch (error) {
		const statusCode = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
		if (statusCode !== 404) throw error;
		await store.putCase(value);
		return "imported" as const;
	}
}

export function noTaskEventIsSafe(row: { message_assessments: unknown; decision: unknown }) {
	const decision = row.decision && typeof row.decision === "object" ? row.decision as Record<string, unknown> : {};
	const options = decision.extractionOptions && typeof decision.extractionOptions === "object" ? decision.extractionOptions as Record<string, unknown> : {};
	const assessments = Array.isArray(row.message_assessments) ? row.message_assessments : [];
	return options.allowSensitiveContent !== true
		&& decision.windowSensitivity === "safe"
		&& assessments.length > 0
		&& assessments.every(assessment => assessment && typeof assessment === "object" && "sensitivity" in assessment && assessment.sensitivity === "safe");
}

export function noTaskEventSampleScore(id: string, seed: string) {
	const digest = createHash("sha256").update(`${seed}\0${id}`).digest();
	return Number(digest.readBigUInt64BE()) / 2 ** 64;
}

export function sampledSafeNoTaskEvents<T extends { id: string; message_assessments: unknown; decision: unknown }>(rows: T[], rate: number, seed: string, limit: number) {
	return rows
		.filter(noTaskEventIsSafe)
		.map(row => ({ row, score: noTaskEventSampleScore(String(row.id), seed) }))
		.filter(item => item.score < rate)
		.sort((left, right) => left.score - right.score || String(left.row.id).localeCompare(String(right.row.id)))
		.slice(0, limit)
		.map(item => item.row);
}

async function main() {
	const corpusConfig = loadAiCorpusConfig();
	const databaseConfig = databaseConfigSchema.parse(process.env);
	const pool = new Pool({ connectionString: databaseConfig.DATABASE_URL, max: 1 });
	const store = await AzureBlobCorpusStore.create({
		accountUrl: corpusConfig.AI_CORPUS_STORAGE_ACCOUNT_URL,
		containerName: corpusConfig.AI_CORPUS_CONTAINER,
		prefix: corpusConfig.AI_CORPUS_PREFIX,
		createContainer: true,
	});
	let imported = 0;
	let updated = 0;
	let unchanged = 0;
	let excluded = 0;
	let sanitized = 0;
	try {
		const existingCases = await Promise.all((await store.listCases()).map(item => store.getCase(item.id)));
		for (const item of existingCases) {
			const safe = sanitizeCorpusCase(item.case);
			if (JSON.stringify(safe) === JSON.stringify(item.case)) continue;
			await store.putCase({ ...safe, updatedAt: new Date().toISOString() }, item.etag);
			sanitized++;
		}
		const existingNoTaskCases = (await store.listCases()).filter(item => item.originType === "sampled_no_task");
		const deletedNoTaskCaseIds = new Set<string>();
		if (existingNoTaskCases.length) {
			const existing = await Promise.all(existingNoTaskCases.map(item => store.getCase(item.id)));
			const eventIds = existing.map(item => item.case.origin.extractionEventId).filter((id): id is string => Boolean(id));
			const safetyRows = eventIds.length ? await pool.query<{ id: string; message_assessments: unknown; decision: unknown }>(
				"SELECT id,message_assessments,decision FROM ai_extraction_events WHERE id=ANY($1::bigint[])",
				[eventIds],
			) : { rows: [] };
			const safety = new Map(safetyRows.rows.map(row => [String(row.id), noTaskEventIsSafe(row)]));
			let invalidated = false;
			for (const item of existing) {
				const eventId = item.case.origin.extractionEventId;
				if (eventId && safety.get(eventId) === true) continue;
				await store.deleteCase(item.case.id);
				deletedNoTaskCaseIds.add(item.case.id);
				excluded++;
				invalidated = true;
			}
			if (invalidated) await store.invalidateIncludedExports();
		}
		const rows = await loadReviewedExtractionRows(pool, corpusConfig.AI_CORPUS_SYNC_DAYS);
		const reviewed = rows.map(row => {
			const correction = buildPendingCorrectionWindow(row);
			return { row, window: buildCorpusWindow(row) ?? correction, correction: Boolean(correction) };
		});
		const queriedExtractionIds = await pool.query<{ id: string }>(
			`SELECT id FROM ai_extraction_events WHERE schema_version='v3' AND input_snapshot IS NOT NULL
			 AND created_at >= now() - ($1::text || ' days')::interval`,
			[corpusConfig.AI_CORPUS_SYNC_DAYS],
		);
		const queriedReviewedIds = new Set(queriedExtractionIds.rows.map(row => `review-${row.id}`));
		const eligibleReviewedIds = new Set(reviewed.flatMap(item => item.window ? [item.window.id] : []));
		for (const item of (await store.listCases()).filter(item => item.originType === "reviewed_proposal" && queriedReviewedIds.has(item.id) && !eligibleReviewedIds.has(item.id))) {
			await store.deleteCase(item.id);
			excluded++;
		}
		for (const { row, window, correction } of reviewed) {
			if (!window) { excluded++; continue; }
			const value = caseFromWindow(window, {
				type: "reviewed_proposal", extractionEventId: row.id, fingerprint: contentHash(window),
				...(correction ? { reviewKind: "incorrect_proposal" as const, reviewFingerprint: contentHash(window.expected.proposals) } : {}),
			}, discordReviewContext(row.input_snapshot, window, databaseConfig.ORGANIZER_GUILD_ID));
			const result = await reconcileCase(store, value);
			if (result === "imported") imported++; else if (result === "updated") updated++; else unchanged++;
		}
		if (existingNoTaskCases.length || (corpusConfig.AI_CORPUS_NO_TASK_SAMPLE_LIMIT && corpusConfig.AI_CORPUS_NO_TASK_SAMPLE_RATE)) {
			const noTasks = await pool.query<{ id: string; input_snapshot: unknown; message_assessments: unknown; decision: unknown }>(
				`SELECT id,input_snapshot,message_assessments,decision FROM ai_extraction_events
				 WHERE schema_version='v3' AND source='automatic' AND outcome='no_task' AND input_snapshot IS NOT NULL
				 AND created_at >= now() - ($1::text || ' days')::interval
				 ORDER BY id`,
				[corpusConfig.AI_CORPUS_SYNC_DAYS],
			);
			const sampled = sampledSafeNoTaskEvents(noTasks.rows, corpusConfig.AI_CORPUS_NO_TASK_SAMPLE_RATE, corpusConfig.AI_CORPUS_NO_TASK_SAMPLE_SEED, corpusConfig.AI_CORPUS_NO_TASK_SAMPLE_LIMIT);
			const queriedIds = new Set(noTasks.rows.map(row => String(row.id)));
			const sampledIds = new Set(sampled.map(row => String(row.id)));
			let invalidated = false;
			for (const item of existingNoTaskCases) {
				if (deletedNoTaskCaseIds.has(item.id)) continue;
				const eventId = item.id.replace(/^no-task-/, "");
				if (!queriedIds.has(eventId) || sampledIds.has(eventId)) continue;
				await store.deleteCase(item.id);
				excluded++;
				invalidated = true;
			}
			if (invalidated) await store.invalidateIncludedExports();
			for (const row of sampled) {
				const window = noTaskWindow(row);
				if (!window) { excluded++; continue; }
				const snapshot = discordSnapshotSchema.safeParse(row.input_snapshot).data ?? [];
				const value = caseFromWindow(window, { type: "sampled_no_task", extractionEventId: String(row.id), fingerprint: contentHash(window) }, discordReviewContext(snapshot, window, databaseConfig.ORGANIZER_GUILD_ID));
				const result = await reconcileCase(store, value);
				if (result === "imported") imported++; else if (result === "updated") updated++; else unchanged++;
			}
		}
		console.log(JSON.stringify({ imported, updated, unchanged, excluded, sanitized }));
	} finally {
		await pool.end();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
