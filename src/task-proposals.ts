import type { WorkPackage } from "./openproject.js";
import { z } from "zod";

export const metadataFieldNames = [
	"subject", "assignee", "priority", "size", "start_date", "due_date", "estimated_hours",
] as const;

export type MetadataFieldName = typeof metadataFieldNames[number];
export type ContentIntent = "none" | "update_note" | "replace_description";
export type ContentOperation = "none" | "descriptionReplacement" | "postComment";
export type MessageAssessment = {
	message_id: string;
	relevance: "relevant" | "supporting" | "unrelated" | "completion" | "superseding" | "unclear";
};

export type ProposalMetadataPatch = {
	subject?: string;
	assigneeDiscordId?: string | null;
	priorityId?: number | null;
	sizeHref?: string | null;
	startDate?: string | null;
	dueDate?: string | null;
	estimatedHours?: number | null;
	status?: "complete" | "reopen";
};

export const proposalMetadataPatchSchema = z.object({
	subject: z.string().min(1).max(255).optional(),
	assigneeDiscordId: z.string().nullable().optional(),
	priorityId: z.number().int().positive().nullable().optional(),
	sizeHref: z.string().nullable().optional(),
	startDate: z.string().nullable().optional(),
	dueDate: z.string().nullable().optional(),
	estimatedHours: z.number().min(0).nullable().optional(),
	status: z.enum(["complete", "reopen"]).optional(),
});

type ExistingTaskPlanInput = {
	workPackage: Pick<WorkPackage, "description">;
	requestedAction: "create" | "update" | "complete" | "reopen";
	contentIntent: ContentIntent;
	description: string;
	metadataFields: MetadataFieldName[];
	values: {
		title: string;
		assigneeDiscordId?: string;
		priorityId?: number;
		sizeHref?: string;
		startDate?: string;
		dueDate?: string;
		estimatedHours?: number;
	};
};

export function workPackageDescription(workPackage: Pick<WorkPackage, "description">) {
	return typeof workPackage.description === "string" ? workPackage.description : workPackage.description?.raw ?? "";
}

export function isEffectivelyEmptyDescription(value: string) {
	const withoutComments = value.replace(/<!--\s*track-the-hack-(?:correlation|proposal):.*?-->/gis, "");
	const withoutManagedSections = withoutComments.replace(
		/(?:^|\n)\s*(?:---\s*\n)?\s*(?:#{1,6}\s*)?(?:Related links|Source)\s*:?\s*\n(?:\s*[-*]\s+https?:\/\/\S+\s*\n?)*/gi,
		"\n",
	);
	const remaining = withoutManagedSections
		.split(/\r?\n/)
		.map(line => line.replace(/^\s*[-*]\s+/, "").trim())
		.filter(Boolean)
		.filter(line => !/^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+\/?$/i.test(line));
	return remaining.length === 0;
}

export function taskSourcesAreRelevant(sourceMessageIds: readonly string[], assessments: readonly MessageAssessment[]) {
	const byId = new Map(assessments.map(assessment => [assessment.message_id, assessment.relevance]));
	const relevance = sourceMessageIds.map(id => byId.get(id));
	return relevance.length > 0 &&
		relevance.every(value => value === "relevant" || value === "supporting" || value === "completion") &&
		relevance.some(value => value === "relevant" || value === "completion");
}

function stripGeneratedReferenceSections(value: string) {
	const lines = value.split(/\r?\n/);
	const output: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (!/^\s*(?:#{1,6}\s*)?(?:related\s+(?:links|references)|references|source(?:\s+conversation)?)\s*:?\s*$/i.test(lines[index])) {
			output.push(lines[index]);
			continue;
		}
		let next = index + 1;
		while (next < lines.length && !lines[next].trim()) next++;
		const firstLink = next;
		while (next < lines.length && /^\s*[-*]\s+https?:\/\/\S+\s*$/i.test(lines[next])) next++;
		if (next === firstLink) {
			output.push(lines[index]);
			continue;
		}
		index = next - 1;
	}
	return output.join("\n").trim();
}

function bulletizeDescription(value: string) {
	if (!value.trim()) return "";
	const output: string[] = [];
	let prose: string[] = [];
	let hasHeading = false;
	const flush = () => {
		if (!prose.length) return;
		const sentences = prose.join(" ").split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}])/u).map(item => item.trim()).filter(Boolean);
		output.push(...sentences.map(sentence => `- ${sentence}`));
		prose = [];
	};
	for (const rawLine of value.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (/^#{1,6}\s+\S/.test(line)) {
			flush();
			if (output.length && output.at(-1) !== "") output.push("");
			output.push(line, "");
			hasHeading = true;
		} else if (/^(?:[-*+]\s+|\d+[.)]\s+)/.test(line)) {
			flush();
			output.push(line);
		} else if (line) {
			prose.push(line);
		} else {
			flush();
			if (output.length && output.at(-1) !== "") output.push("");
		}
	}
	flush();
	const body = output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	return hasHeading ? body : `## Details\n\n${body}`;
}

export function formatGeneratedTaskDescription(value: string, referenceLinks: readonly string[] = []) {
	const links = [...new Set(referenceLinks.map(link => link.trim()).filter(Boolean))];
	let cleaned = stripGeneratedReferenceSections(value);
	cleaned = cleaned
		.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gi, "$1")
		.replace(/\s+at\s+https?:\/\/[^\s<>()]+/gi, "")
		.replace(/https?:\/\/[^\s<>()]+/gi, "")
		.replace(/[ \t]+([.,;:!?])/g, "$1")
		.replace(/[ \t]+\n/g, "\n");
	const body = bulletizeDescription(cleaned);
	let references = "";
	for (const link of links) {
		const addition = `${references ? "" : "## References\n\n"}- ${link}\n`;
		if (references.length + addition.length > 2000) break;
		references += addition;
	}
	const separator = body && references ? "\n\n" : "";
	const bodyLimit = Math.max(0, 4000 - separator.length - references.trimEnd().length);
	return `${body.slice(0, bodyLimit).trimEnd()}${separator}${references.trimEnd()}`;
}

export function composeOpenProjectMarkdown(body: string, sourceLinks: string[], marker?: string) {
	const links = [...new Set(sourceLinks.map(link => link.trim()).filter(Boolean))];
	const source = links.length ? `## Source\n\n${links.map(link => `- ${link}`).join("\n")}` : "";
	const withoutSource = body.replace(
		/(?:^|\n)\s*(?:#{1,6}\s*)?source(?:\s+conversation)?\s*:?\s*\n(?:\s*[-*]\s+https?:\/\/\S+\s*\n?)*/gi,
		"\n",
	).trim();
	return [withoutSource, source, marker ? `<!-- ${marker} -->` : ""].filter(Boolean).join("\n\n");
}

export function planExistingTaskOperations(input: ExistingTaskPlanInput) {
	const selected = new Set(input.metadataFields);
	const metadataPatch: ProposalMetadataPatch = {};
	if (selected.has("subject")) metadataPatch.subject = input.values.title;
	if (selected.has("assignee") && input.values.assigneeDiscordId !== undefined) metadataPatch.assigneeDiscordId = input.values.assigneeDiscordId;
	if (selected.has("priority") && input.values.priorityId !== undefined) metadataPatch.priorityId = input.values.priorityId;
	if (selected.has("size") && input.values.sizeHref !== undefined) metadataPatch.sizeHref = input.values.sizeHref;
	if (selected.has("start_date") && input.values.startDate !== undefined) metadataPatch.startDate = input.values.startDate;
	if (selected.has("due_date") && input.values.dueDate !== undefined) metadataPatch.dueDate = input.values.dueDate;
	if (selected.has("estimated_hours") && input.values.estimatedHours !== undefined) metadataPatch.estimatedHours = input.values.estimatedHours;
	if (input.requestedAction === "complete" || input.requestedAction === "reopen") metadataPatch.status = input.requestedAction;

	const hasContent = Boolean(input.description.trim()) && (input.requestedAction === "create" || input.contentIntent !== "none");
	let contentOperation: ContentOperation = "none";
	if (hasContent) {
		contentOperation = input.contentIntent === "replace_description" || isEffectivelyEmptyDescription(workPackageDescription(input.workPackage))
			? "descriptionReplacement"
			: "postComment";
	}
	return { metadataPatch, contentOperation, contentMarkdown: contentOperation === "none" ? null : input.description.trim() };
}

export function describeProposalOperations(contentOperation: ContentOperation, metadataPatch: ProposalMetadataPatch) {
	const content = contentOperation === "postComment"
		? "Add an update comment"
		: contentOperation === "descriptionReplacement" ? "Replace the task description" : null;
	const metadata = Object.entries(metadataPatch).map(([field, value]) => {
		const name = field.replace(/([A-Z])/g, " $1").replace(/_/g, " ");
		return `Change ${name} to ${value === null ? "not set" : String(value)}`;
	});
	return [...(content ? [content] : []), ...metadata];
}
