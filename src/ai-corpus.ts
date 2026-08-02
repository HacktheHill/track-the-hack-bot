import { createHash } from "node:crypto";
import { z } from "zod";
import { minimizeText } from "./azure-openai.js";

export const CORPUS_SCHEMA_VERSION = "v1" as const;
export const CORPUS_CASE_SCHEMA_VERSION = "v2" as const;

export const corpusExclusionReasonSchema = z.enum([
	"missing_context",
	"missing_attachment",
	"broken_reference",
	"ambiguous_ground_truth",
	"sensitive_content",
	"duplicate",
	"malformed_capture",
	"out_of_scope",
	"other",
]);

export const corpusMessageSchema = z.object({
	id: z.string().min(1),
	authorAlias: z.string().min(1),
	text: z.string(),
	timestamp: z.iso.datetime(),
	replyTo: z.string().optional(),
	contextRole: z.enum(["primary", "preceding", "subsequent", "thread_root", "reply_target", "referenced_history"]).optional(),
	priority: z.boolean().optional(),
	attachments: z.array(z.object({ id: z.string(), name: z.string(), contentType: z.string().optional(), url: z.url() })).optional(),
});

export const expectedProposalSchema = z.object({
	action: z.enum(["create", "update", "complete", "reopen"]),
	titleIncludes: z.array(z.string().trim().min(1)).min(1),
	projectName: z.string().trim().min(1).nullable().optional(),
	assigneeAlias: z.string().nullable().optional(),
	dueDate: z.iso.date().nullable().optional(),
	sourceMessageIds: z.array(z.string().min(1)).min(1),
});

export const corpusWindowSchema = z.object({
	id: z.string().min(1),
	mode: z.enum(["manual", "automatic"]),
	messages: z.array(corpusMessageSchema).min(1),
	metadata: z.object({ priorities: z.array(z.string()).optional(), sizes: z.array(z.string()).optional(), projects: z.array(z.string()).optional() }).optional(),
	routing: z.object({ availableTargetSourceMessageIds: z.array(z.array(z.string()).min(1)).default([]) }).optional(),
	expected: z.object({ proposals: z.array(expectedProposalSchema).max(5) }),
}).superRefine((window, context) => {
	const ids = new Set(window.messages.map(message => message.id));
	if (ids.size !== window.messages.length) context.addIssue({ code: "custom", message: "Corpus message IDs must be unique." });
	const focal = window.messages.filter(message => message.contextRole === "primary" || message.priority);
	if (window.mode === "automatic" && focal.length !== 1) {
		context.addIssue({ code: "custom", message: "Automatic evaluation windows require exactly one primary or priority focal message." });
	}
	if (window.mode === "manual" && !focal.length) {
		context.addIssue({ code: "custom", message: "Manual evaluation windows require at least one primary or priority focal message." });
	}
	for (const proposal of window.expected.proposals) {
		for (const id of proposal.sourceMessageIds) if (!ids.has(id)) context.addIssue({ code: "custom", message: `Expected proposal cites unknown message ${id}.` });
	}
});

const corpusAdjudicationSchema = z.object({
	status: z.enum(["pending", "included", "excluded"]),
	exclusionReasons: z.array(corpusExclusionReasonSchema).default([]),
	notes: z.string().max(4000).default(""),
	reviewedAt: z.iso.datetime().optional(),
	reviewedBy: z.string().max(200).optional(),
}).superRefine((adjudication, context) => {
	if (adjudication.status === "excluded" && !adjudication.exclusionReasons.length) {
		context.addIssue({ code: "custom", message: "Excluded corpus cases require at least one exclusion reason." });
	}
	if (adjudication.status !== "excluded" && adjudication.exclusionReasons.length) {
		context.addIssue({ code: "custom", message: "Only excluded corpus cases may have exclusion reasons." });
	}
	if (adjudication.exclusionReasons.includes("other") && !adjudication.notes.trim()) {
		context.addIssue({ code: "custom", message: "The other exclusion reason requires reviewer notes." });
	}
});

export const corpusCaseSchema = z.object({
	schemaVersion: z.literal(CORPUS_CASE_SCHEMA_VERSION),
	id: z.string().min(1).max(160).regex(/^[a-zA-Z0-9._-]+$/),
	origin: z.object({
		type: z.enum(["reviewed_proposal", "sampled_no_task", "manual_scenario"]),
		extractionEventId: z.string().optional(),
		fingerprint: z.string().optional(),
		reviewKind: z.literal("incorrect_proposal").optional(),
		reviewFingerprint: z.string().length(64).regex(/^[a-f0-9]+$/).optional(),
	}),
	window: corpusWindowSchema,
	reviewContext: z.object({
		discordMessages: z.record(z.string(), z.object({
			guildId: z.string().regex(/^\d+$/),
			channelId: z.string().regex(/^\d+$/),
			messageId: z.string().regex(/^\d+$/),
			url: z.url(),
		})),
		reconstruction: z.object({
			recoveredAt: z.iso.datetime(),
			recoveredBy: z.string().max(200).optional(),
			baseFingerprint: z.string().optional(),
			addedMessageIds: z.array(z.string().min(1)),
		}).optional(),
	}).optional(),
	adjudication: corpusAdjudicationSchema,
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
}).superRefine((value, context) => {
	if (Boolean(value.origin.reviewKind) !== Boolean(value.origin.reviewFingerprint)) {
		context.addIssue({ code: "custom", message: "Correction review kind and fingerprint must be provided together." });
	}
	if (value.origin.reviewKind && value.origin.type !== "reviewed_proposal") {
		context.addIssue({ code: "custom", message: "Correction reviews require a reviewed proposal origin." });
	}
	if (value.adjudication.status === "included" && value.origin.reviewFingerprint === contentHash(value.window.expected.proposals)) {
		context.addIssue({ code: "custom", message: "Correction cases must change or remove the seeded expected proposals before inclusion." });
	}
	const messageIds = new Set(value.window.messages.map(message => message.id));
	for (const [id, reference] of Object.entries(value.reviewContext?.discordMessages ?? {})) {
		if (!messageIds.has(id)) context.addIssue({ code: "custom", message: `Discord reference points to unknown corpus message ${id}.` });
		const expectedUrl = `https://discord.com/channels/${reference.guildId}/${reference.channelId}/${reference.messageId}`;
		if (reference.url !== expectedUrl) context.addIssue({ code: "custom", message: `Discord reference for ${id} has an invalid URL.` });
	}
	for (const id of value.reviewContext?.reconstruction?.addedMessageIds ?? []) {
		if (!messageIds.has(id)) context.addIssue({ code: "custom", message: `Reconstruction points to unknown corpus message ${id}.` });
		if (!value.reviewContext?.discordMessages[id]) context.addIssue({ code: "custom", message: `Reconstructed message ${id} requires a Discord reference.` });
	}
	if (new Set(value.reviewContext?.reconstruction?.addedMessageIds ?? []).size !== (value.reviewContext?.reconstruction?.addedMessageIds.length ?? 0)) {
		context.addIssue({ code: "custom", message: "Reconstructed corpus message IDs must be unique." });
	}
});

export type CorpusWindow = z.infer<typeof corpusWindowSchema>;
export type CorpusCase = z.infer<typeof corpusCaseSchema>;
export type CorpusExclusionReason = z.infer<typeof corpusExclusionReasonSchema>;

function sanitizeMetadata(value: unknown): unknown {
	if (typeof value === "string") return minimizeText(value);
	if (Array.isArray(value)) return value.map(sanitizeMetadata);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeMetadata(item)]));
	return value;
}

export function sanitizeCorpusWindow(value: CorpusWindow) {
	const parsed = corpusWindowSchema.parse(value);
	return corpusWindowSchema.parse({
		...parsed,
		messages: parsed.messages.map(message => ({
			...message,
			authorAlias: minimizeText(message.authorAlias),
			text: minimizeText(message.text),
			...(message.attachments ? { attachments: message.attachments.map(attachment => ({
				...attachment,
				name: minimizeText(attachment.name),
				url: `https://example.invalid/attachment/${encodeURIComponent(attachment.id)}`,
			})) } : {}),
		})),
		...(parsed.metadata ? { metadata: sanitizeMetadata(parsed.metadata) } : {}),
			expected: { proposals: parsed.expected.proposals.map(proposal => ({
			...proposal,
			titleIncludes: proposal.titleIncludes.map(minimizeText),
			...(proposal.projectName ? { projectName: minimizeText(proposal.projectName) } : {}),
			...(proposal.assigneeAlias ? { assigneeAlias: minimizeText(proposal.assigneeAlias) } : {}),
		})) },
	});
}

export function sanitizeCorpusCase(value: CorpusCase) {
	const parsed = corpusCaseSchema.parse(value);
	return corpusCaseSchema.parse({
		...parsed,
		window: sanitizeCorpusWindow(parsed.window),
		adjudication: { ...parsed.adjudication, notes: minimizeText(parsed.adjudication.notes) },
	});
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, item]) => [key, canonicalValue(item)]));
}

export function canonicalJson(value: unknown) {
	return JSON.stringify(canonicalValue(value));
}

export function contentHash(value: unknown) {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parseCorpusJsonl(input: string) {
	return input.split(/\r?\n/).map((line, index) => ({ line, index })).filter(item => item.line.trim()).map(({ line, index }) => {
		try {
			return corpusWindowSchema.parse(JSON.parse(line));
		} catch (error) {
			throw new Error(`Invalid corpus line ${index + 1}: ${(error as Error).message}`);
		}
	});
}

export function corpusJsonl(windows: CorpusWindow[]) {
	return windows.map(window => JSON.stringify(corpusWindowSchema.parse(window))).join("\n") + (windows.length ? "\n" : "");
}
