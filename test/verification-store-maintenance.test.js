import assert from "node:assert/strict";
import test from "node:test";
import { VerificationStore } from "../dist/verification-store.js";

const storeWith = pool => {
	const store = Object.create(VerificationStore.prototype);
	store.pool = pool;
	return store;
};

test("expired challenge cleanup uses the supplied database timestamp", async () => {
	const calls = [];
	const store = storeWith({
		query: async (...args) => {
			calls.push(args);
			return { rowCount: 2 };
		},
	});
	const now = Date.parse("2026-09-23T00:00:00Z");
	assert.equal(await store.cleanupExpiredChallenges(now), 2);
	assert.match(calls[0][0], /expires_at <= \$1/);
	assert.deepEqual(calls[0][1], [new Date(now)]);
});

test("unlink removes challenges even when a Discord ID has no existing mapping", async () => {
	const statements = [];
	let released = false;
	const client = {
		query: async (sql, values) => {
			statements.push([sql, values]);
			if (sql.startsWith("SELECT")) return { rows: [], rowCount: 0 };
			if (sql.includes("DELETE FROM discord_verification_challenges")) return { rows: [], rowCount: 3 };
			if (sql.includes("DELETE FROM discord_participant_links")) return { rows: [], rowCount: 0 };
			return { rows: [], rowCount: null };
		},
		release: () => {
			released = true;
		},
	};
	const store = storeWith({ connect: async () => client });
	assert.deepEqual(await store.unlinkParticipant({ discordId: "12345678901234567" }), {
		links: 0,
		challenges: 3,
	});
	assert.deepEqual(statements.map(([sql]) => sql), [
		"BEGIN",
		"LOCK TABLE discord_verification_challenges IN ACCESS EXCLUSIVE MODE",
		"SELECT discord_id FROM discord_participant_links WHERE discord_id=$1 FOR UPDATE",
		"DELETE FROM discord_verification_challenges WHERE discord_id=$1",
		"DELETE FROM discord_participant_links WHERE discord_id=$1",
		"COMMIT",
	]);
	assert.equal(released, true);
});

test("unlink resolves a participant before atomically removing its Discord state", async () => {
	const discordId = "12345678901234567";
	const values = [];
	const client = {
		query: async (sql, parameters) => {
			values.push(parameters);
			if (sql.startsWith("SELECT")) return { rows: [{ discord_id: discordId }], rowCount: 1 };
			if (sql.includes("DELETE FROM discord_verification_challenges")) return { rows: [], rowCount: 1 };
			if (sql.includes("DELETE FROM discord_participant_links")) return { rows: [], rowCount: 1 };
			return { rows: [], rowCount: null };
		},
		release() {},
	};
	const store = storeWith({ connect: async () => client });
	assert.deepEqual(await store.unlinkParticipant({ hackerId: "abcdefghijklmnopqrstuv" }), {
		links: 1,
		challenges: 1,
	});
	assert.deepEqual(values.filter(Boolean).slice(-2), [[discordId], [discordId]]);
});

test("reset requires an exclusive lock and rolls back failures", async () => {
	const statements = [];
	const client = {
		query: async sql => {
			statements.push(sql);
			if (sql === "DELETE FROM discord_verification_challenges") throw new Error("database failure");
			return { rows: [], rowCount: null };
		},
		release() {},
	};
	const store = storeWith({ connect: async () => client });
	await assert.rejects(store.resetParticipantLinks(), /database failure/);
	assert.deepEqual(statements, [
		"BEGIN",
		"LOCK TABLE discord_verification_challenges, discord_participant_links IN ACCESS EXCLUSIVE MODE",
		"DELETE FROM discord_verification_challenges",
		"ROLLBACK",
	]);
});
