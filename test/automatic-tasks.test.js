import assert from "node:assert/strict";
import test from "node:test";
import { automaticFocalWindows } from "../dist/automatic-tasks.js";

test("automatic batches evaluate every message as its own focal window", () => {
	assert.deepEqual(automaticFocalWindows(["a", "b", "c"]), [
		["a"],
		["a", "b"],
		["a", "b", "c"],
	]);
});

test("automatic focal windows enforce their global context bound", () => {
	assert.deepEqual(automaticFocalWindows(["a", "b", "c", "d"], 2), [
		["a"],
		["a", "b"],
		["b", "c"],
		["c", "d"],
	]);
});
