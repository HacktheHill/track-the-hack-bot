import assert from "node:assert/strict";
import test from "node:test";
import { automaticFocalWindows, messageRevisionChanged, proposalOwnerText } from "../dist/automatic-tasks.js";

test("automatic batches evaluate every message as its own focal window", () => {
	assert.deepEqual(automaticFocalWindows(["a", "b", "c"]), [
		{ messages: ["a", "b", "c"], focal: "a" },
		{ messages: ["a", "b", "c"], focal: "b" },
		{ messages: ["a", "b", "c"], focal: "c" },
	]);
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
