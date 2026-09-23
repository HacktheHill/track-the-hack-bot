import assert from "node:assert/strict";
import test from "node:test";
import { VerificationError, VerificationStore } from "../dist/verification-store.js";

const databaseUrl = process.env.VERIFICATION_TEST_DATABASE_URL;

test("PostgreSQL verification maintenance clears expired, linked, and reset state", { skip: !databaseUrl }, async t => {
	const url = new URL(databaseUrl);
	assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
	assert.match(url.pathname, /test/);
	const store = new VerificationStore(databaseUrl);
	t.after(() => store.close());
	await store.migrate();
	await store.resetParticipantLinks();

	const now = Date.parse("2026-09-23T00:00:00Z");
	await store.pool.query(
		"INSERT INTO discord_verification_challenges(reference_hash,discord_id,expires_at) VALUES($1,$2,$3),($4,$5,$6)",
		["expired", "12345678901234567", new Date(now), "future", "12345678901234568", new Date(now + 60_000)],
	);
	assert.equal(await store.cleanupExpiredChallenges(now), 1);
	assert.equal((await store.pool.query("SELECT 1 FROM discord_verification_challenges")).rowCount, 1);

	const secret = "test-shared-secret-more-than-32-characters";
	const firstLink = await store.createLink("https://tracker.example", secret, "12345678901234567", now);
	const firstToken = new URL(firstLink).hash.slice(1);
	await store.bind(firstToken, "abcdefghijklmnopqrstuv", secret, now);
	await store.createLink("https://tracker.example", secret, "12345678901234567", now);
	assert.deepEqual(await store.unlinkParticipant({ hackerId: "abcdefghijklmnopqrstuv" }), {
		links: 1,
		challenges: 2,
	});
	await assert.rejects(store.bind(firstToken, "abcdefghijklmnopqrstuv", secret, now), error => {
		return error instanceof VerificationError && error.status === 410;
	});

	for (const [discordId, hackerId] of [
		["12345678901234567", "abcdefghijklmnopqrstuv"],
		["12345678901234568", "bcdefghijklmnopqrstuvw"],
	]) {
		const link = await store.createLink("https://tracker.example", secret, discordId, now);
		await store.bind(new URL(link).hash.slice(1), hackerId, secret, now);
	}
	const reset = await store.resetParticipantLinks();
	assert.equal(reset.links, 2);
	assert.ok(reset.challenges >= 2);
	assert.equal((await store.pool.query("SELECT 1 FROM discord_participant_links")).rowCount, 0);
	assert.equal((await store.pool.query("SELECT 1 FROM discord_verification_challenges")).rowCount, 0);
});
