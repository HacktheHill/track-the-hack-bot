import assert from "node:assert/strict";
import test from "node:test";
import { automaticBatchSource, automaticFocalWindows, messageRevisionChanged, proposalOwnerText, reconciledSupersessionIds, registerAutomaticTaskDetection, sourceEditShouldReconcile } from "../dist/automatic-tasks.js";

test("automatic batches evaluate every message as its own focal window", () => {
	assert.deepEqual(automaticFocalWindows(["a", "b", "c"]), [
		{ messages: ["a", "b", "c"], focal: "a" },
		{ messages: ["a", "b", "c"], focal: "b" },
		{ messages: ["a", "b", "c"], focal: "c" },
	]);
});

test("automatic batches enforce a hard focal-message budget", () => {
	assert.deepEqual(automaticBatchSource(["a", "b", "c", "d", "e", "f", "g"]), ["b", "c", "d", "e", "f", "g"]);
});

test("automatic focal windows include subsequent context within their bound", () => {
	assert.deepEqual(automaticFocalWindows(["a", "b", "c", "d"], 3), [
		{ messages: ["a", "b", "c"], focal: "a" },
		{ messages: ["a", "b", "c"], focal: "b" },
		{ messages: ["b", "c", "d"], focal: "c" },
		{ messages: ["b", "c", "d"], focal: "d" },
	]);
});

test("automatic focal windows do not cross conversation gaps", () => {
	const messages = [
		{ id: "a", createdTimestamp: 0 },
		{ id: "b", createdTimestamp: 60_000 },
		{ id: "c", createdTimestamp: 60 * 60_000 },
	];
	assert.deepEqual(automaticFocalWindows(messages, 8, 30 * 60_000).map(window => ({
		messages: window.messages.map(message => message.id), focal: window.focal.id,
	})), [
		{ messages: ["a", "b"], focal: "a" },
		{ messages: ["a", "b"], focal: "b" },
		{ messages: ["c"], focal: "c" },
	]);
});

test("automatic proposal cards show plain owner labels without mention syntax", () => {
	assert.equal(proposalOwnerText("Alex", "Alex"), "Assignee: Alex | Accountable: Alex\n");
	assert.equal(proposalOwnerText("Alex", "Morgan"), "Assignee: Alex | Accountable: Morgan\n");
	assert.equal(proposalOwnerText(undefined, "Morgan"), "Accountable: Morgan\n");
	assert.equal(proposalOwnerText().includes("<@"), false);
});

test("message edits enqueue only content or attachment changes and partials fail open", () => {
	assert.equal(messageRevisionChanged("same", "same", "a:url", "a:url"), false);
	assert.equal(messageRevisionChanged("old", "new", "a:url", "a:url"), true);
	assert.equal(messageRevisionChanged("same", "same", "a:url", "b:url"), true);
	assert.equal(messageRevisionChanged(undefined, "current", "", ""), true);
});

test("off and shadow source maintenance is limited to cited pending proposals", () => {
	assert.equal(sourceEditShouldReconcile("off", []), false);
	assert.equal(sourceEditShouldReconcile("shadow", []), false);
	assert.equal(sourceEditShouldReconcile("off", ["proposal"]), true);
	assert.equal(sourceEditShouldReconcile("shadow", ["proposal"]), true);
	assert.equal(sourceEditShouldReconcile("review", []), true);
});

test("source update and delete listeners register even when automatic creation is off", () => {
	const listeners = new Map();
	const client = { on(event, listener) { listeners.set(event, listener); } };
	registerAutomaticTaskDetection(client, {
		config: { OPENPROJECT_AUTOMATION_MODE: "off" },
		extractor: { enabled: false }, db: {}, openProject: {},
	});
	assert.deepEqual([...listeners.keys()], ["messageCreate", "messageUpdate", "messageDelete"]);
});

test("proposal supersession requires an affirmative safe transition", () => {
	assert.deepEqual(reconciledSupersessionIds({
		reconciledCount: 0, eligibleCount: 0, extractedCount: 0, reconciliationSucceeded: true,
		persistedProposalIds: new Set(), recommendedSupersessionIds: [], invalidatableProposalIds: ["old"],
	}), []);
	assert.deepEqual(reconciledSupersessionIds({
		reconciledCount: 0, eligibleCount: 0, extractedCount: 0, reconciliationSucceeded: true,
		persistedProposalIds: new Set(), recommendedSupersessionIds: ["old"], invalidatableProposalIds: ["old", "multi-source"],
	}), []);
	assert.deepEqual(reconciledSupersessionIds({
		reconciledCount: 1, eligibleCount: 1, extractedCount: 1, reconciliationSucceeded: true,
		persistedProposalIds: new Set(["survivor"]), recommendedSupersessionIds: ["survivor", "duplicate"], invalidatableProposalIds: [],
	}), ["duplicate"]);
});
