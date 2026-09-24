import assert from "node:assert/strict";
import test from "node:test";
import { createVerificationApp } from "../dist/verification-api.js";
import { signNotificationRequest } from "../dist/verification-proof.js";

const secret = "notification-test-secret-at-least-32-characters";
const hackerId = "participant_0123456789_abcdef";

const start = async () => {
	const sent = [];
	const receipts = new Map();
	const store = {
		linkedStatuses: async ids => new Set(ids.filter(id => id === hackerId)),
		discordIdForHacker: async id => id === hackerId ? "private-discord-id" : undefined,
		beginNotificationDelivery: async (id, participant, hash) => {
			const existing = receipts.get(id);
			if (existing && (existing.participant !== participant || existing.hash !== hash)) return { action: "conflict" };
			if (existing?.status === "sent") return { action: "complete", outcome: "sent" };
			receipts.set(id, { participant, hash, status: "sending" });
			return { action: "send" };
		},
		finishNotificationDelivery: async (id, result) => receipts.set(id, { ...receipts.get(id), status: result.status }),
		bind: async () => "private-discord-id",
	};
	const app = createVerificationApp({
		secret,
		store,
		isReady: () => true,
		grantRole: async () => undefined,
		sendDirectMessage: async (discordId, content) => {
			sent.push({ discordId, content });
			return "private-message-id";
		},
	});
	const server = app.listen(0);
	await new Promise(resolve => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test server address");
	return { base: `http://127.0.0.1:${address.port}`, sent, close: () => new Promise(resolve => server.close(resolve)) };
};

const signedPost = (base, path, domain, value, signatureSecret = secret) => {
	const body = JSON.stringify(value);
	const timestamp = String(Math.floor(Date.now() / 1000));
	return fetch(`${base}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-track-the-hack-timestamp": timestamp,
			"x-track-the-hack-signature": signNotificationRequest(domain, body, timestamp, signatureSecret),
		},
		body,
	});
};

test("signed link status reveals only hacker IDs and booleans", async t => {
	const server = await start();
	t.after(server.close);
	const response = await signedPost(server.base, "/participant-links/status", "participant-links-status", { hackerIds: [hackerId, "participant_abcdefghij_klmnop"] });
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(body.links, [{ hackerId, linked: true }, { hackerId: "participant_abcdefghij_klmnop", linked: false }]);
	assert.doesNotMatch(JSON.stringify(body), /discord-id/);
});

test("DM delivery is authenticated, safe, and idempotent", async t => {
	const server = await start();
	t.after(server.close);
	const delivery = { id: "9f85ef0c-d0a0-4d65-9d99-ff8d656af320", hackerId, content: "Lunch is ready / Le dîner est prêt" };
	const first = await signedPost(server.base, "/notifications/deliver", "notifications-deliver", { deliveries: [delivery] });
	const second = await signedPost(server.base, "/notifications/deliver", "notifications-deliver", { deliveries: [delivery] });
	assert.equal(first.status, 200);
	assert.equal(second.status, 200);
	assert.equal(server.sent.length, 1);
	assert.deepEqual(await second.json(), { ok: true, deliveries: [{ id: delivery.id, outcome: "sent" }] });
	const rejected = await signedPost(server.base, "/notifications/deliver", "notifications-deliver", { deliveries: [delivery] }, "wrong-secret-that-is-still-long-enough-value");
	assert.equal(rejected.status, 403);
});
