// Local E2E fixture: real bot router + PostgreSQL; only Discord role I/O is doubled.
import { z } from "zod";
import { grantVerifiedHackerRole } from "../../dist/verification-role.js";
import { VerificationStore } from "../../dist/verification-store.js";
import { createVerificationApp } from "../../dist/verification-api.js";
import { signDiscordLink } from "../../dist/verification-proof.js";
import { createHash, randomBytes } from "node:crypto";

const databaseUrl = new URL(process.env.VERIFICATION_TEST_DATABASE_URL ?? "");
if (databaseUrl.hostname !== "127.0.0.1" || databaseUrl.pathname !== "/discord_verification_test") {
	throw new Error("Verification E2E requires its disposable loopback database");
}
const secret = process.env.INTERNAL_API_SECRET;
if (!secret) throw new Error("Test shared secret missing");
const store = new VerificationStore(databaseUrl.toString());
for (let attempt = 0; ; attempt++) {
	try { await store.migrate(); break; }
	catch (error) { if (attempt >= 30) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
}
let failRole = false;
const roles = new Set();
const app = createVerificationApp({
	secret, store, isReady: () => true,
	grantRole: async discordId => {
		const client = { guilds: { fetch: async () => ({
			members: { fetch: async () => ({ roles: {
				cache: { has: () => roles.has(discordId) },
				add: async () => { if (failRole) throw new Error("Simulated Discord outage"); roles.add(discordId); },
			} }) }, roles: { fetch: async () => ({ id: "hacker-role" }) },
		}) } };
		await grantVerifiedHackerRole(client, "community", "hacker-role", discordId, async () => {});
	},
});
const server = app.listen(0, "127.0.0.1", () => {
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No verification port");
	process.send?.({ ready: true, port: address.port });
});
const commandSchema = z.discriminatedUnion("command", [
	z.object({ command: z.literal("link"), requestId: z.string(), baseUrl: z.string().url(), discordId: z.string(), expired: z.boolean().optional() }),
	z.object({ command: z.literal("failure"), requestId: z.string(), enabled: z.boolean() }),
	z.object({ command: z.literal("role"), requestId: z.string(), discordId: z.string() }),
	z.object({ command: z.literal("state"), requestId: z.string() }),
]);
process.on("message", async message => {
	const input = commandSchema.parse(message);
	try {
		let result;
		if (input.command === "link") {
			if (input.expired) {
				// Seed an expired challenge without advancing the server's clock.
				const reference = randomBytes(32).toString("base64url");
				const expires = Math.floor(Date.now() / 1000) - 1;
				await store.pool.query("INSERT INTO discord_verification_challenges VALUES($1,$2,$3)",
					[createHash("sha256").update(reference).digest("hex"), input.discordId, new Date(expires * 1000)]);
				result = `${input.baseUrl}/discord#${signDiscordLink(reference, expires, secret)}`;
			} else result = await store.createLink(input.baseUrl, secret, input.discordId);
		} else if (input.command === "failure") { failRole = input.enabled; result = true; }
		else if (input.command === "role") { roles.add(input.discordId); result = true; }
		else result = { mappings: (await store.pool.query("SELECT discord_id,hacker_id FROM discord_participant_links ORDER BY discord_id")).rows, roles: [...roles] };
		process.send?.({ requestId: input.requestId, result });
	} catch { process.send?.({ requestId: input.requestId, error: "Fixture command failed" }); }
});
process.once("SIGTERM", () => {
	server.close(() => void store.close().then(() => process.exit(0)));
});
