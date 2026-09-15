import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { readDiscordProof, signDiscordLink, signDiscordRequest } from "../dist/verification-proof.js";

test("verification proofs expire and bind the opaque reference with a separate signing domain", () => {
	const now = Date.now();
	const secret = "test-shared-secret-more-than-32-characters";
	const reference = randomBytes(32).toString("base64url");
	const expires = Math.floor(now / 1000) + 300;
	const token = signDiscordLink(reference, expires, secret);
	assert.equal(readDiscordProof(token, secret, now)?.reference, reference);
	assert.equal(readDiscordProof(token, secret, expires * 1000), null);
	assert.equal(readDiscordProof(token, "wrong-secret", now), null);
	assert.equal(readDiscordProof(token.replace(reference, randomBytes(32).toString("base64url")), secret, now), null);
	assert.notEqual(signDiscordRequest(token, String(expires), secret), token.slice(-64));
});
