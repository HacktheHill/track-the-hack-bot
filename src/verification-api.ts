import { timingSafeEqual } from "node:crypto";
import express from "express";
import type { ErrorRequestHandler } from "express";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
	signDiscordRequest,
	signNotificationRequest,
} from "./verification-proof.js";
import {
	VerificationError,
	type VerificationStore,
} from "./verification-store.js";

const requestSchema = z
	.object({
		token: z.string().min(1).max(256),
		hackerId: z
			.string()
			.min(22)
			.max(128)
			.regex(/^[A-Za-z0-9_-]+$/)
			.refine(id => !/^\d+$/.test(id)),
	})
	.strict();

const hackerIdSchema = z
	.string()
	.min(22)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/)
	.refine(id => !/^\d+$/.test(id));
const statusRequestSchema = z
	.object({ hackerIds: z.array(hackerIdSchema).max(500) })
	.strict();
const deliveryRequestSchema = z
	.object({
		deliveries: z
			.array(
				z
					.object({
						id: z.string().uuid(),
						hackerId: hackerIdSchema,
						content: z.string().trim().min(1).max(500),
					})
					.strict(),
			)
			.min(1)
			.max(50),
	})
	.strict();

const validSignature = (
	domain: "participant-links-status" | "notifications-deliver",
	body: string,
	timestamp: string | undefined,
	signature: string | undefined,
	secret: string,
) =>
	Boolean(
		timestamp &&
		/^\d{10}$/.test(timestamp) &&
		Math.abs(Date.now() - Number(timestamp) * 1000) <= 300_000 &&
		signature &&
		/^[a-f0-9]{64}$/.test(signature) &&
		timingSafeEqual(
			Buffer.from(signature, "hex"),
			Buffer.from(
				signNotificationRequest(domain, body, timestamp, secret),
				"hex",
			),
		),
	);

export function createVerificationApp(options: {
	secret: string;
	store: VerificationStore;
	grantRole: (discordId: string) => Promise<void>;
	sendDirectMessage: (discordId: string, content: string) => Promise<string>;
	isReady: () => boolean;
}) {
	const app = express();
	const startedAt = new Date().toISOString();
	app.disable("x-powered-by");
	app.use((_req, res, next) => {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("X-Frame-Options", "DENY");
		res.setHeader("Content-Security-Policy", "default-src 'none'");
		res.setHeader(
			"Strict-Transport-Security",
			"max-age=31536000; includeSubDomains",
		);
		next();
	});
	app.post(
		"/verify",
		express.raw({ type: "application/json", limit: "2kb" }),
		async (req, res) => {
			if (!Buffer.isBuffer(req.body))
				return res.status(400).json({ ok: false });
			const body = req.body.toString("utf8");
			const timestamp = req.header("x-track-the-hack-timestamp");
			const signature = req.header("x-track-the-hack-signature");
			if (
				!timestamp ||
				!/^\d{10}$/.test(timestamp) ||
				Math.abs(Date.now() - Number(timestamp) * 1000) > 300_000 ||
				!signature ||
				!/^[a-f0-9]{64}$/.test(signature) ||
				!timingSafeEqual(
					Buffer.from(signature, "hex"),
					Buffer.from(
						signDiscordRequest(body, timestamp, options.secret),
						"hex",
					),
				)
			) {
				return res.status(403).json({ ok: false });
			}
			let input: unknown;
			try {
				input = JSON.parse(body);
			} catch {
				return res.status(400).json({ ok: false });
			}
			const parsed = requestSchema.safeParse(input);
			if (!parsed.success) return res.status(400).json({ ok: false });
			if (!options.isReady()) return res.status(503).json({ ok: false });
			try {
				const discordId = await options.store.bind(
					parsed.data.token,
					parsed.data.hackerId,
					options.secret,
				);
				await options.grantRole(discordId);
				return res.json({ ok: true });
			} catch (error) {
				if (error instanceof VerificationError)
					return res
						.status(error.status)
						.json(error.status === 409 ? { ok: false, reason: error.reason } : { ok: false });
				// Do not send/log request bodies, capabilities or Discord exceptions.
				console.error("Discord verification failed");
				return res.status(503).json({ ok: false });
			}
		},
	);
	app.post(
		"/participant-links/status",
		express.raw({ type: "application/json", limit: "96kb" }),
		async (req, res) => {
			if (!Buffer.isBuffer(req.body))
				return res.status(400).json({ ok: false });
			const body = req.body.toString("utf8");
			if (
				!validSignature(
					"participant-links-status",
					body,
					req.header("x-track-the-hack-timestamp"),
					req.header("x-track-the-hack-signature"),
					options.secret,
				)
			) {
				return res.status(403).json({ ok: false });
			}
			let input: unknown;
			try {
				input = JSON.parse(body);
			} catch {
				return res.status(400).json({ ok: false });
			}
			const parsed = statusRequestSchema.safeParse(input);
			if (!parsed.success) return res.status(400).json({ ok: false });
			const linked = await options.store.linkedStatuses(
				parsed.data.hackerIds,
			);
			return res.json({
				ok: true,
				links: parsed.data.hackerIds.map(hackerId => ({
					hackerId,
					linked: linked.has(hackerId),
				})),
			});
		},
	);
	app.post(
		"/notifications/deliver",
		express.raw({ type: "application/json", limit: "64kb" }),
		async (req, res) => {
			if (!Buffer.isBuffer(req.body))
				return res.status(400).json({ ok: false });
			const body = req.body.toString("utf8");
			if (
				!validSignature(
					"notifications-deliver",
					body,
					req.header("x-track-the-hack-timestamp"),
					req.header("x-track-the-hack-signature"),
					options.secret,
				)
			) {
				return res.status(403).json({ ok: false });
			}
			let input: unknown;
			try {
				input = JSON.parse(body);
			} catch {
				return res.status(400).json({ ok: false });
			}
			const parsed = deliveryRequestSchema.safeParse(input);
			if (!parsed.success) return res.status(400).json({ ok: false });
			if (!options.isReady()) return res.status(503).json({ ok: false });
			const results = [];
			for (const delivery of parsed.data.deliveries) {
				const contentHash = createHash("sha256")
					.update(delivery.content)
					.digest("hex");
				const claim = await options.store.beginNotificationDelivery(
					delivery.id,
					delivery.hackerId,
					contentHash,
				);
				if (claim.action === "conflict")
					return res.status(409).json({ ok: false });
				if (claim.action === "complete") {
					results.push({ id: delivery.id, outcome: claim.outcome });
					continue;
				}
				const discordId = await options.store.discordIdForHacker(
					delivery.hackerId,
				);
				if (!discordId) {
					await options.store.finishNotificationDelivery(
						delivery.id,
						{ status: "failed", failureCode: "not_linked" },
					);
					results.push({ id: delivery.id, outcome: "not_linked" });
					continue;
				}
				try {
					const messageId = await options.sendDirectMessage(
						discordId,
						delivery.content,
					);
					await options.store.finishNotificationDelivery(
						delivery.id,
						{ status: "sent", discordMessageId: messageId },
					);
					results.push({ id: delivery.id, outcome: "sent" });
				} catch (error) {
					const code =
						typeof error === "object" && error && "code" in error
							? Number(error.code)
							: 0;
					const outcome =
						code === 50007
							? "dm_unavailable"
							: code
								? "temporary_failure"
								: "uncertain";
					await options.store.finishNotificationDelivery(
						delivery.id,
						{ status: "failed", failureCode: outcome },
					);
					results.push({ id: delivery.id, outcome });
				}
			}
			return res.json({ ok: true, deliveries: results });
		},
	);
	app.get("/healthz", (_req, res) => res.json({ status: "ok", startedAt }));
	app.get("/readyz", (_req, res) =>
		res
			.status(options.isReady() ? 200 : 503)
			.json({ status: options.isReady() ? "ready" : "not_ready" }),
	);
	const invalidRequest: ErrorRequestHandler = (_error, _req, res, _next) => {
		res.status(400).json({ ok: false });
	};
	app.use(invalidRequest);
	return app;
}
