import type { WorkPackage } from "./openproject.js";
import { z } from "zod";

export const metadataFieldNames = [
	"subject", "assignee", "priority", "size", "start_date", "due_date", "estimated_hours",
] as const;

export type MetadataFieldName = typeof metadataFieldNames[number];
export type ContentIntent = "none" | "update_note" | "replace_description";
export type ContentOperation = "none" | "descriptionReplacement" | "postComment";

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

export function composeOpenProjectMarkdown(body: string, sourceLinks: string[], marker?: string) {
	const links = [...new Set(sourceLinks.map(link => link.trim()).filter(Boolean))];
	const source = links.length ? `## Source\n\n${links.map(link => `- ${link}`).join("\n")}` : "";
	return [body.trim(), source, marker ? `<!-- ${marker} -->` : ""].filter(Boolean).join("\n\n");
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
