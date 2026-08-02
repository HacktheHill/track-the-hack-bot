import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import express, { type Request, type Response } from "express";
import { REST } from "discord.js";
import { z } from "zod";
import { AzureBlobCorpusStore, type CorpusStore } from "./ai-corpus-blob.js";
import { corpusCaseSchema, sanitizeCorpusCase, type CorpusCase } from "./ai-corpus.js";
import { loadAiCorpusConfig } from "./ai-corpus-config.js";
import { createDiscordCorpusRecovery, type CorpusRecoveryPreview } from "./discord-corpus-recovery.js";

const caseRequestSchema = z.object({ case: corpusCaseSchema, etag: z.string().optional() });
const recoveryRequestSchema = z.object({ etag: z.string().min(1), messageUrls: z.array(z.string().min(1)).min(1).max(40) });

function localAuthority(value?: string) {
	if (!value) return false;
	try {
		const url = new URL(value.includes("://") ? value : `http://${value}`);
		return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
	} catch {
		return false;
	}
}

function sessionToken(request: Request) {
	const cookies = request.headers.cookie?.split(";").map(value => value.trim().split("=")).find(([name]) => name === "corpus_session");
	return cookies?.[1] ? decodeURIComponent(cookies[1]) : undefined;
}

export function createCorpusApp(options: {
	store: CorpusStore;
	token: string;
	assetsDirectory: string;
	reviewer?: string;
	recoverContext?: (value: CorpusCase, messageUrls: string[]) => Promise<CorpusRecoveryPreview>;
}) {
	const app = express();
	app.disable("x-powered-by");
	app.use((request, response, next) => {
		if (!localAuthority(request.headers.host)) return response.status(403).send("Localhost access only.");
		if (request.headers.origin && !localAuthority(request.headers.origin)) return response.status(403).send("Cross-origin requests are not allowed.");
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		next();
	});
	app.use("/api", (request, response, next) => {
		if (sessionToken(request) !== options.token) return response.status(401).send("Invalid corpus session.");
		next();
	});
	app.use(express.json({ limit: "1mb" }));

	app.get("/api/summary", async (_request, response, next) => {
		try {
			const cases = await options.store.listCases();
			const counters = { total: cases.length, pending: 0, included: 0, excluded: 0 };
			for (const item of cases) counters[item.status]++;
			const manifest = await options.store.getExportManifest();
			response.json({ counters, ...counters, export: manifest ? { lastExportedAt: manifest.generatedAt, includedCount: manifest.caseCount, sha256: manifest.sha256 } : null });
		} catch (error) { next(error); }
	});

	app.get("/api/cases", async (request, response, next) => {
		try {
			const status = z.enum(["pending", "included", "excluded"]).optional().parse(request.query.status);
			const query = typeof request.query.query === "string" ? request.query.query.toLocaleLowerCase().trim() : "";
			const cases = (await options.store.listCases()).filter(item => (!status || item.status === status) && (!query || `${item.id}\n${item.originType}\n${item.reviewKind ?? ""}\n${item.preview}`.toLocaleLowerCase().includes(query)));
			response.json({ cases });
		} catch (error) { next(error); }
	});

	app.get("/api/cases/:id", async (request, response, next) => {
		try { response.json(await options.store.getCase(request.params.id)); }
		catch (error) { next(error); }
	});

	app.post("/api/cases/:id/reconstruction-preview", async (request, response, next) => {
		try {
			if (!options.recoverContext) return response.status(503).send("Discord context recovery is not configured for this local review desk.");
			const input = recoveryRequestSchema.parse(request.body);
			const current = await options.store.getCase(request.params.id);
			if (current.etag !== input.etag) return response.status(409).send("This case changed after it was opened. Reload before recovering context.");
			const preview = await options.recoverContext(current.case, input.messageUrls);
			response.json({ ...preview, etag: current.etag });
		} catch (error) { next(error); }
	});

	app.put("/api/cases/:id", async (request, response, next) => {
		try {
			const input = caseRequestSchema.parse(request.body);
			if (input.case.id !== request.params.id) return response.status(400).send("Case ID cannot be changed.");
			const now = new Date().toISOString();
			const value = sanitizeCorpusCase(corpusCaseSchema.parse({
				...input.case,
				updatedAt: now,
				adjudication: {
					...input.case.adjudication,
					...(input.case.adjudication.status === "pending" ? { reviewedAt: undefined, reviewedBy: undefined } : { reviewedAt: now, reviewedBy: options.reviewer ?? "local-reviewer" }),
				},
			}));
			const result = await options.store.putCase(value, input.etag);
			response.json({ case: value, etag: result.etag });
		} catch (error) { next(error); }
	});

	app.post("/api/cases", async (request, response, next) => {
		try {
			const input = caseRequestSchema.parse(request.body);
			const now = new Date().toISOString();
			const value = sanitizeCorpusCase(corpusCaseSchema.parse({
				...input.case,
				origin: { type: "manual_scenario" },
				adjudication: { status: "pending", exclusionReasons: [], notes: input.case.adjudication.notes },
				createdAt: now,
				updatedAt: now,
			}));
			const result = await options.store.putCase(value);
			response.status(201).json({ case: value, etag: result.etag });
		} catch (error) { next(error); }
	});

	app.post("/api/export", async (_request, response, next) => {
		try {
			const manifest = await options.store.exportIncluded();
			response.json({ count: manifest.caseCount, message: `Exported ${manifest.caseCount} included cases.`, manifest });
		} catch (error) { next(error); }
	});

	app.get("/", async (_request, response, next) => {
		try {
			const request = _request;
			if (sessionToken(request) !== options.token) {
				if (request.query.token !== options.token) return response.status(401).send("Open the one-time URL printed by the corpus UI process.");
				response.setHeader("Set-Cookie", `corpus_session=${encodeURIComponent(options.token)}; HttpOnly; SameSite=Strict; Path=/`);
				return response.redirect(303, "/");
			}
			const html = await readFile(resolve(options.assetsDirectory, "index.html"), "utf8");
			response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
			response.type("html").send(html);
		} catch (error) { next(error); }
	});
	app.use(express.static(options.assetsDirectory, { index: false, etag: true, maxAge: "1h" }));
	app.use((error: unknown, _request: Request, response: Response, _next: unknown) => {
		const statusCode = error instanceof z.ZodError ? 400 : error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
		const safeStatus = statusCode === 404 ? 404 : statusCode === 409 || statusCode === 412 ? 409 : statusCode >= 400 && statusCode < 500 ? 400 : 500;
		const detail = error instanceof z.ZodError ? error.issues[0]?.message ?? "Invalid corpus request." : (error as Error).message;
		response.status(safeStatus).send(safeStatus === 500 ? "Corpus operation failed. Check the local terminal for the error category." : detail);
		console.error("Corpus UI request failed", { status: safeStatus, error: error instanceof Error ? error.name : "unknown" });
	});
	return app;
}

async function main() {
	const config = loadAiCorpusConfig();
	const store = await AzureBlobCorpusStore.create({
		accountUrl: config.AI_CORPUS_STORAGE_ACCOUNT_URL,
		containerName: config.AI_CORPUS_CONTAINER,
		prefix: config.AI_CORPUS_PREFIX,
	});
	const token = randomBytes(32).toString("base64url");
	const reviewer = process.env.USER ?? process.env.USERNAME;
	const recoverContext = process.env.DISCORD_TOKEN && process.env.ORGANIZER_GUILD_ID
		? createDiscordCorpusRecovery({ rest: new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN), guildId: process.env.ORGANIZER_GUILD_ID, reviewer })
		: undefined;
	const app = createCorpusApp({ store, token, assetsDirectory: resolve("dist/corpus-ui"), reviewer, recoverContext });
	app.listen(config.AI_CORPUS_UI_PORT, "127.0.0.1", () => {
		console.log(`Corpus review desk: http://127.0.0.1:${config.AI_CORPUS_UI_PORT}/?token=${token}`);
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
