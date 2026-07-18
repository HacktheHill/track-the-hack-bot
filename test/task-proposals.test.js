import assert from "node:assert/strict";
import test from "node:test";
import {
	composeOpenProjectMarkdown,
	isEffectivelyEmptyDescription,
	planExistingTaskOperations,
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
	const markdown = composeOpenProjectMarkdown("## Objective\n\nShip it.", ["https://example.test/source", "https://example.test/source"], "marker");
	assert.equal(markdown.match(/https:\/\/example\.test\/source/g)?.length, 1);
	assert.match(markdown, /## Source/);
	assert.ok(markdown.endsWith("<!-- marker -->"));
});
