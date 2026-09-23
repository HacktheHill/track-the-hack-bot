import assert from "node:assert/strict";
import test from "node:test";
import { parseVerificationMaintenanceArguments } from "../dist/manage-verification.js";

const hackerId = "abcdefghijklmnopqrstuv";

test("verification maintenance accepts only explicit bounded operations", () => {
	assert.deepEqual(parseVerificationMaintenanceArguments(["cleanup"]), { command: "cleanup" });
	assert.deepEqual(parseVerificationMaintenanceArguments(["unlink", "--discord-id", "12345678901234567"]), {
		command: "unlink",
		selector: { discordId: "12345678901234567" },
	});
	assert.deepEqual(parseVerificationMaintenanceArguments(["unlink", "--hacker-id", hackerId]), {
		command: "unlink",
		selector: { hackerId },
	});
	assert.deepEqual(parseVerificationMaintenanceArguments(["reset", "--confirm-current-event-reset"]), {
		command: "reset",
	});
	for (const args of [
		[],
		["unlink"],
		["unlink", "--discord-id", "not-a-discord-id"],
		["unlink", "--hacker-id", "1234567890123456789012"],
		["reset"],
		["reset", "--confirm"],
	]) {
		assert.throws(() => parseVerificationMaintenanceArguments(args));
	}
});
