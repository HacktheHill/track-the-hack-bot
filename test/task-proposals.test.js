import assert from "node:assert/strict";
import test from "node:test";
import {
	composeOpenProjectMarkdown,
	formatGeneratedTaskDescription,
	isEffectivelyEmptyDescription,
	planExistingTaskOperations,
	taskReferencesAreValid,
} from "../dist/task-proposals.js";

test("effectively empty descriptions ignore managed provenance but preserve real context", () => {
	assert.equal(isEffectivelyEmptyDescription(""), true);
	assert.equal(isEffectivelyEmptyDescription("- https://discord.com/channels/1/2/3"), true);
	assert.equal(isEffectivelyEmptyDescription("## Source\n\n- https://discord.com/channels/1/2/3\n\n<!-- track-the-hack-correlation:x -->"), true);
	assert.equal(isEffectivelyEmptyDescription("Canonical sponsorship package: https://drive.example/package"), false);
});

test("existing task planning replaces empty descriptions and comments on substantive ones", () => {
	const input = {
		requestedAction: "update",
		contentIntent: "update_note",
		description: "## Requirements\n\n- Change the wording.",
		metadataFields: [],
		values: { title: "Update wording" },
	};
	assert.equal(planExistingTaskOperations({ ...input, workPackage: { description: "" } }).contentOperation, "descriptionReplacement");
	assert.equal(planExistingTaskOperations({ ...input, workPackage: { description: "Existing scope" } }).contentOperation, "postComment");
	assert.equal(planExistingTaskOperations({ ...input, contentIntent: "replace_description", workPackage: { description: "Existing scope" } }).contentOperation, "descriptionReplacement");
});

test("existing task planning patches only explicit metadata fields", () => {
	const planned = planExistingTaskOperations({
		workPackage: { description: "Existing scope" }, requestedAction: "update", contentIntent: "none", description: "Retrieval text",
		metadataFields: ["subject", "due_date"], values: { title: "New title", dueDate: "2026-07-31", assigneeDiscordId: "ignored" },
	});
	assert.deepEqual(planned, {
		metadataPatch: { subject: "New title", dueDate: "2026-07-31" },
		contentOperation: "none",
		contentMarkdown: null,
	});
});

test("unresolved metadata is preserved instead of being cleared", () => {
	const planned = planExistingTaskOperations({
		workPackage: { description: "Existing scope" }, requestedAction: "update", contentIntent: "none", description: "Retrieval text",
		metadataFields: ["assignee", "priority", "due_date"], values: { title: "Existing title" },
	});
	assert.deepEqual(planned.metadataPatch, {});
});

test("Markdown composition deduplicates source links and appends its marker", () => {
	const markdown = composeOpenProjectMarkdown("## Objective\n\nShip it.\n\n## Source\n\n- https://stale.test/source", ["https://example.test/source", "https://example.test/source"], "marker");
	assert.equal(markdown.match(/https:\/\/example\.test\/source/g)?.length, 1);
	assert.equal(markdown.includes("https://stale.test/source"), false);
	assert.match(markdown, /## Source/);
	assert.ok(markdown.endsWith("<!-- marker -->"));
});

test("task references require valid IDs and at least one focal message", () => {
	const validMessages = new Set(["recent", "detail"]);
	const focalMessages = new Set(["recent"]);
	const validAttachments = new Set(["image"]);
	assert.equal(taskReferencesAreValid({ source_message_ids: ["recent", "detail"], relevant_attachment_ids: ["image"] }, validMessages, focalMessages, validAttachments), true);
	assert.equal(taskReferencesAreValid({ source_message_ids: ["detail"], relevant_attachment_ids: [] }, validMessages, focalMessages, validAttachments), false);
	assert.equal(taskReferencesAreValid({ source_message_ids: ["recent", "missing"], relevant_attachment_ids: [] }, validMessages, focalMessages, validAttachments), false);
	assert.equal(taskReferencesAreValid({ source_message_ids: ["recent"], relevant_attachment_ids: ["missing"] }, validMessages, focalMessages, validAttachments), false);
});

test("generated descriptions use bullets and one verified references section", () => {
	const description = formatGeneratedTaskDescription(
		"Update the sponsor graphic colors using the [mockup](https://verified.test/mockup). Reorganize the tier layout.\n\n- Preserve the sponsor logos.\n\nAdd mobile spacing. Ignore https://hallucinated.test.\n\nRelated references:\n- https://unverified.test\n\nRelated links:\n- https://duplicate.test",
		["https://verified.test/mockup", "https://verified.test/mockup"],
	);
	assert.match(description, /^## Details\n\n- Update the sponsor graphic colors using the mockup\.\n- Reorganize the tier layout\./);
	assert.match(description, /- Preserve the sponsor logos\.[\s\S]*- Add mobile spacing\./);
	assert.equal((description.match(/## References/g) ?? []).length, 1);
	assert.equal((description.match(/https:\/\/verified\.test\/mockup/g) ?? []).length, 1);
	assert.match(description, /https:\/\/verified\.test\/mockup/);
	assert.equal(description.includes("unverified.test"), false);
	assert.equal(description.includes("hallucinated.test"), false);
	assert.equal(description.includes("[mockup]()"), false);
	assert.equal(description.includes("Related links"), false);
});
