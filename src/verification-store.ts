import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { DISCORD_LINK_TTL_SECONDS, readDiscordProof, signDiscordLink } from "./verification-proof.js";

const challengeSchema = z.object({ discord_id: z.string(), expires_at: z.date() });
export class VerificationError extends Error {
	constructor(readonly status: 409 | 410) {
		super(status === 409 ? "Account already linked" : "Invalid verification link");
	}
}
const referenceHash = (reference: string) => createHash("sha256").update(reference).digest("hex");

// This pool uses only the bot's PostgreSQL database. Track's database has no
// Discord fields, and the raw verification capability is never stored here.
export class VerificationStore {
	readonly pool: pg.Pool;
	constructor(databaseUrl: string) {
		this.pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
	}
	async migrate() {
		await this.pool.query(`
			CREATE TABLE IF NOT EXISTS discord_participant_links (
				discord_id TEXT PRIMARY KEY,
				hacker_id TEXT UNIQUE NOT NULL,
				linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			CREATE TABLE IF NOT EXISTS discord_verification_challenges (
				reference_hash TEXT PRIMARY KEY,
				discord_id TEXT NOT NULL,
				expires_at TIMESTAMPTZ NOT NULL
			);
			CREATE INDEX IF NOT EXISTS discord_verification_expiry_idx
				ON discord_verification_challenges(expires_at);
		`);
	}
	async createLink(baseUrl: string, secret: string, discordId: string, now = Date.now()) {
		const reference = randomBytes(32).toString("base64url");
		const expires = Math.floor(now / 1000) + DISCORD_LINK_TTL_SECONDS;
		await this.pool.query("DELETE FROM discord_verification_challenges WHERE expires_at <= $1", [new Date(now)]);
		await this.pool.query(
			"INSERT INTO discord_verification_challenges(reference_hash,discord_id,expires_at) VALUES($1,$2,$3)",
			[referenceHash(reference), discordId, new Date(expires * 1000)],
		);
		const link = new URL("/discord", baseUrl);
		link.hash = signDiscordLink(reference, expires, secret);
		return link.toString();
	}
	async bind(token: string, hackerId: string, secret: string, now = Date.now()) {
		const proof = readDiscordProof(token, secret, now);
		if (!proof) throw new VerificationError(410);
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const result = await client.query(
				"SELECT discord_id,expires_at FROM discord_verification_challenges WHERE reference_hash=$1 FOR UPDATE",
				[referenceHash(proof.reference)],
			);
			const parsed = challengeSchema.safeParse(result.rows[0]);
			if (!parsed.success || parsed.data.expires_at.getTime() !== proof.expiresAt.getTime() ||
				parsed.data.expires_at.getTime() <= now) throw new VerificationError(410);
			const discordId = parsed.data.discord_id;
			// Unique constraints serialize competing claims in either direction.
			// Reserve the binding before Discord I/O so a failed role grant cannot
			// let another participant take over a link. Same-pair retries are safe.
			await client.query(
				"INSERT INTO discord_participant_links(discord_id,hacker_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
				[discordId, hackerId],
			);
			const existing = await client.query(
				"SELECT 1 FROM discord_participant_links WHERE discord_id=$1 AND hacker_id=$2",
				[discordId, hackerId],
			);
			if (!existing.rowCount) throw new VerificationError(409);
			await client.query("COMMIT");
			return discordId;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
	async close() { await this.pool.end(); }
}
