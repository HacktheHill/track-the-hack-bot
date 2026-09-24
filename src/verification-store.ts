import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import {
	DISCORD_LINK_TTL_SECONDS,
	readDiscordProof,
	signDiscordLink,
} from "./verification-proof.js";

const challengeSchema = z.object({
	discord_id: z.string(),
	expires_at: z.date(),
});
export class VerificationError extends Error {
	constructor(readonly status: 409 | 410) {
		super(
			status === 409
				? "Account already linked"
				: "Invalid verification link",
		);
	}
}
const referenceHash = (reference: string) =>
	createHash("sha256").update(reference).digest("hex");

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
			CREATE TABLE IF NOT EXISTS notification_delivery_receipts (
				delivery_id UUID PRIMARY KEY,
				hacker_id TEXT NOT NULL,
				content_hash CHAR(64) NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('sending','sent','failed','uncertain')),
				failure_code TEXT,
				discord_message_id TEXT,
				attempts INTEGER NOT NULL DEFAULT 1,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			CREATE INDEX IF NOT EXISTS notification_delivery_status_idx
				ON notification_delivery_receipts(status, updated_at);
		`);
	}
	async linkedStatuses(hackerIds: string[]) {
		if (!hackerIds.length) return new Set<string>();
		const result = await this.pool.query<{ hacker_id: string }>(
			"SELECT hacker_id FROM discord_participant_links WHERE hacker_id=ANY($1::text[])",
			[hackerIds],
		);
		return new Set(result.rows.map(row => row.hacker_id));
	}
	async discordIdForHacker(hackerId: string) {
		const result = await this.pool.query<{ discord_id: string }>(
			"SELECT discord_id FROM discord_participant_links WHERE hacker_id=$1",
			[hackerId],
		);
		return result.rows[0]?.discord_id;
	}
	async beginNotificationDelivery(
		deliveryId: string,
		hackerId: string,
		contentHash: string,
	) {
		const inserted = await this.pool.query<{
			status: string;
			failure_code: string | null;
		}>(
			`INSERT INTO notification_delivery_receipts(delivery_id,hacker_id,content_hash,status)
			 VALUES($1,$2,$3,'sending') ON CONFLICT DO NOTHING RETURNING status,failure_code`,
			[deliveryId, hackerId, contentHash],
		);
		if (inserted.rowCount) return { action: "send" as const };
		const current = await this.pool.query<{
			hacker_id: string;
			content_hash: string;
			status: string;
			failure_code: string | null;
		}>(
			"SELECT hacker_id,content_hash,status,failure_code FROM notification_delivery_receipts WHERE delivery_id=$1",
			[deliveryId],
		);
		const receipt = current.rows[0];
		if (
			!receipt ||
			receipt.hacker_id !== hackerId ||
			receipt.content_hash !== contentHash
		) {
			return { action: "conflict" as const };
		}
		if (receipt.status === "sent")
			return { action: "complete" as const, outcome: "sent" as const };
		if (receipt.status === "uncertain" || receipt.status === "sending") {
			if (receipt.status === "sending") {
				await this.pool.query(
					"UPDATE notification_delivery_receipts SET status='uncertain',failure_code='uncertain',updated_at=now() WHERE delivery_id=$1 AND status='sending'",
					[deliveryId],
				);
			}
			return {
				action: "complete" as const,
				outcome: "uncertain" as const,
			};
		}
		const retried = await this.pool.query(
			"UPDATE notification_delivery_receipts SET status='sending',failure_code=NULL,attempts=attempts+1,updated_at=now() WHERE delivery_id=$1 AND status='failed'",
			[deliveryId],
		);
		return retried.rowCount
			? { action: "send" as const }
			: { action: "complete" as const, outcome: "uncertain" as const };
	}
	async finishNotificationDelivery(
		deliveryId: string,
		result:
			| { status: "sent"; discordMessageId: string }
			| { status: "failed"; failureCode: string },
	) {
		await this.pool.query(
			`UPDATE notification_delivery_receipts SET status=$2,failure_code=$3,discord_message_id=$4,updated_at=now()
			 WHERE delivery_id=$1 AND status='sending'`,
			[
				deliveryId,
				result.status,
				result.status === "failed" ? result.failureCode : null,
				result.status === "sent" ? result.discordMessageId : null,
			],
		);
	}
	async createLink(
		baseUrl: string,
		secret: string,
		discordId: string,
		now = Date.now(),
	) {
		const reference = randomBytes(32).toString("base64url");
		const expires = Math.floor(now / 1000) + DISCORD_LINK_TTL_SECONDS;
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				"DELETE FROM discord_verification_challenges WHERE expires_at <= $1",
				[new Date(now)],
			);
			await client.query(
				"INSERT INTO discord_verification_challenges(reference_hash,discord_id,expires_at) VALUES($1,$2,$3)",
				[referenceHash(reference), discordId, new Date(expires * 1000)],
			);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
		const link = new URL("/discord", baseUrl);
		link.hash = signDiscordLink(reference, expires, secret);
		return link.toString();
	}
	async cleanupExpiredChallenges(now = Date.now()) {
		const result = await this.pool.query(
			"DELETE FROM discord_verification_challenges WHERE expires_at <= $1",
			[new Date(now)],
		);
		return result.rowCount ?? 0;
	}
	async unlinkParticipant(selector: {
		discordId?: string;
		hackerId?: string;
	}) {
		if (Boolean(selector.discordId) === Boolean(selector.hackerId)) {
			throw new Error("Provide exactly one verification-link selector");
		}
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			// Block link generation and redemption until both challenge and binding state are removed.
			await client.query(
				"LOCK TABLE discord_verification_challenges IN ACCESS EXCLUSIVE MODE",
			);
			const link = selector.discordId
				? await client.query<{ discord_id: string }>(
						"SELECT discord_id FROM discord_participant_links WHERE discord_id=$1 FOR UPDATE",
						[selector.discordId],
					)
				: await client.query<{ discord_id: string }>(
						"SELECT discord_id FROM discord_participant_links WHERE hacker_id=$1 FOR UPDATE",
						[selector.hackerId],
					);
			const discordId = selector.discordId ?? link.rows[0]?.discord_id;
			if (!discordId) {
				await client.query("COMMIT");
				return { links: 0, challenges: 0 };
			}
			const challenges = await client.query(
				"DELETE FROM discord_verification_challenges WHERE discord_id=$1",
				[discordId],
			);
			const links = await client.query(
				"DELETE FROM discord_participant_links WHERE discord_id=$1",
				[discordId],
			);
			await client.query("COMMIT");
			return {
				links: links.rowCount ?? 0,
				challenges: challenges.rowCount ?? 0,
			};
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
	async resetParticipantLinks() {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				"LOCK TABLE discord_verification_challenges, discord_participant_links IN ACCESS EXCLUSIVE MODE",
			);
			const challenges = await client.query(
				"DELETE FROM discord_verification_challenges",
			);
			const links = await client.query(
				"DELETE FROM discord_participant_links",
			);
			await client.query("COMMIT");
			return {
				links: links.rowCount ?? 0,
				challenges: challenges.rowCount ?? 0,
			};
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
	async bind(
		token: string,
		hackerId: string,
		secret: string,
		now = Date.now(),
	) {
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
			if (
				!parsed.success ||
				parsed.data.expires_at.getTime() !==
					proof.expiresAt.getTime() ||
				parsed.data.expires_at.getTime() <= now
			)
				throw new VerificationError(410);
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
	async close() {
		await this.pool.end();
	}
}
