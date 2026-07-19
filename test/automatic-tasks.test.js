import assert from "node:assert/strict";
import test from "node:test";
import { automaticFocalWindows, uniqueMentionIds } from "../dist/automatic-tasks.js";

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

test("automatic proposal mentions contain each reviewer once", () => {
	assert.deepEqual(uniqueMentionIds("owner", "owner"), ["owner"]);
	assert.deepEqual(uniqueMentionIds("assignee", "accountable"), ["assignee", "accountable"]);
	assert.deepEqual(uniqueMentionIds(undefined, "accountable"), ["accountable"]);
});
