import { timingSafeEqual } from "node:crypto";
import express from "express";
import type { ErrorRequestHandler } from "express";
import { z } from "zod";
import { signDiscordRequest } from "./verification-proof.js";
import { VerificationError, type VerificationStore } from "./verification-store.js";

const requestSchema = z.object({
	token: z.string().min(1).max(256),
	hackerId: z.string().min(22).max(128).regex(/^[A-Za-z0-9_-]+$/).refine(id => !/^\d+$/.test(id)),
}).strict();

export function createVerificationApp(options: {
	secret: string;
	store: VerificationStore;
	grantRole: (discordId: string) => Promise<void>;
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
		res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
		next();
	});
	app.post("/verify", express.raw({ type: "application/json", limit: "2kb" }), async (req, res) => {
		if (!Buffer.isBuffer(req.body)) return res.status(400).json({ ok: false });
		const body = req.body.toString("utf8");
		const timestamp = req.header("x-track-the-hack-timestamp");
		const signature = req.header("x-track-the-hack-signature");
		if (!timestamp || !/^\d{10}$/.test(timestamp) ||
			Math.abs(Date.now() - Number(timestamp) * 1000) > 300_000 ||
			!signature || !/^[a-f0-9]{64}$/.test(signature) ||
			!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(signDiscordRequest(body, timestamp, options.secret), "hex"))) {
			return res.status(403).json({ ok: false });
		}
		let input: unknown;
		try { input = JSON.parse(body); } catch { return res.status(400).json({ ok: false }); }
		const parsed = requestSchema.safeParse(input);
		if (!parsed.success) return res.status(400).json({ ok: false });
		if (!options.isReady()) return res.status(503).json({ ok: false });
		try {
			const discordId = await options.store.bind(parsed.data.token, parsed.data.hackerId, options.secret);
			await options.grantRole(discordId);
			return res.json({ ok: true });
		} catch (error) {
			if (error instanceof VerificationError) return res.status(error.status).json({ ok: false });
			// Do not send/log request bodies, capabilities or Discord exceptions.
			console.error("Discord verification failed");
			return res.status(503).json({ ok: false });
		}
	});
	app.get("/healthz", (_req, res) => res.json({ status: "ok", startedAt }));
	app.get("/readyz", (_req, res) => res.status(options.isReady() ? 200 : 503).json({ status: options.isReady() ? "ready" : "not_ready" }));
	const invalidRequest: ErrorRequestHandler = (_error, _req, res, _next) => {
		res.status(400).json({ ok: false });
	};
	app.use(invalidRequest);
	return app;
}
