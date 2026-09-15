import assert from "node:assert/strict";
import test from "node:test";
import { grantVerifiedHackerRole } from "../dist/verification-role.js";

test("role assignment preserves the existing Hacker role and retries failures", async () => {
	let hasRole = false;
	let fail = true;
	let additions = 0;
	let logs = 0;
	const member = { roles: { cache: { has: id => { assert.equal(id, "hacker-role"); return hasRole; } },
		add: async role => { assert.equal(role.id, "hacker-role"); if (fail) throw new Error("Discord unavailable"); hasRole = true; additions++; } } };
	const client = { guilds: { fetch: async id => {
		assert.equal(id, "community");
		return { members: { fetch: async userId => { assert.equal(userId, "discord-user"); return member; } },
			roles: { fetch: async roleId => ({ id: roleId }) } };
	} } };
	const run = () => grantVerifiedHackerRole(client, "community", "hacker-role", "discord-user", async () => { logs++; });
	await assert.rejects(run(), /Discord unavailable/);
	assert.equal(logs, 0);
	fail = false;
	await run();
	await run();
	assert.equal(additions, 1);
	assert.equal(logs, 1);
});
