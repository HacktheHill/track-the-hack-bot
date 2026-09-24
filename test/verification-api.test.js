import assert from "node:assert/strict";
import test from "node:test";
import { createVerificationApp } from "../dist/verification-api.js";
import { signDiscordRequest } from "../dist/verification-proof.js";
import { VerificationError } from "../dist/verification-store.js";

const secret = "verification-api-test-secret-at-least-32-characters";
const body = JSON.stringify({
	token: "v1.test-reference.1800000300.test-signature",
	hackerId: "participant_0123456789_abcdef",
});

const request = async reason => {
	const store = {
		bind: async () => {
			throw new VerificationError(409, reason);
		},
	};
	const app = createVerificationApp({
		secret,
		store,
		isReady: () => true,
		grantRole: async () => undefined,
		sendDirectMessage: async () => "unused",
	});
	const server = app.listen(0);
	await new Promise(resolve => server.once("listening", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing test server address");
		const timestamp = String(Math.floor(Date.now() / 1000));
		return await fetch(`http://127.0.0.1:${address.port}/verify`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-track-the-hack-timestamp": timestamp,
				"x-track-the-hack-signature": signDiscordRequest(body, timestamp, secret),
			},
			body,
		});
	} finally {
		await new Promise(resolve => server.close(resolve));
	}
};

test("verification conflicts expose only a fixed reason without account identifiers", async () => {
	for (const reason of ["discord-account-linked", "participant-linked", "both-linked"]) {
		const response = await request(reason);
		assert.equal(response.status, 409);
		assert.deepEqual(await response.json(), { ok: false, reason });
	}
});
