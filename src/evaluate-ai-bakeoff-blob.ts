import "dotenv/config";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { assertAggregateBakeoffReport, bakeoffCacheKey, runBakeoff, validBakeoffCacheEntry } from "./ai-bakeoff.js";
import { AzureBlobCorpusStore, blobEtagsEqual } from "./ai-corpus-blob.js";
import { loadAiCorpusConfig } from "./ai-corpus-config.js";
import { parseCorpusJsonl } from "./ai-corpus.js";
import { evaluationEnvSchema } from "./evaluate-ai.js";

async function streamText(stream: NodeJS.ReadableStream | undefined) {
	if (!stream) throw new Error("Blob response did not contain a body.");
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

export function parseBakeoffBlobArguments(arguments_: string[]) {
	if (arguments_.some(argument => argument !== "--full")) throw new Error("Usage: npm run evaluate:ai-bakeoff-blob -- [--full]");
	return { full: arguments_.includes("--full") };
}

async function main() {
	const cli = parseBakeoffBlobArguments(process.argv.slice(2));
	const config = loadAiCorpusConfig();
	const prefix = config.AI_CORPUS_PREFIX ? `${config.AI_CORPUS_PREFIX.replace(/\/$/, "")}/` : "";
	const service = new BlobServiceClient(config.AI_CORPUS_STORAGE_ACCOUNT_URL, new DefaultAzureCredential());
	const container = service.getContainerClient(config.AI_CORPUS_CONTAINER);
	const store = await AzureBlobCorpusStore.create({ accountUrl: config.AI_CORPUS_STORAGE_ACCOUNT_URL, containerName: config.AI_CORPUS_CONTAINER, prefix: config.AI_CORPUS_PREFIX });
	const directory = await mkdtemp(join(tmpdir(), "hth-ai-bakeoff-"));
	const cacheDirectory = join(directory, "cache");
	try {
		await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
		const manifestBlob = container.getBlobClient(`${prefix}exports/current-manifest.json`);
		const manifestDownload = await manifestBlob.download();
		if (!manifestDownload.etag) throw new Error("Current corpus manifest is missing an ETag.");
		const manifest = z.object({ blobName: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), caseVersions: z.record(z.string(), z.string().min(1)) }).parse(JSON.parse(await streamText(manifestDownload.readableStreamBody)));
		await store.assertExportCurrent(manifest);
		const corpusText = await streamText((await container.getBlobClient(manifest.blobName).download()).readableStreamBody);
		if (createHash("sha256").update(corpusText).digest("hex") !== manifest.sha256) throw new Error("Included corpus digest does not match its manifest.");
		const windows = parseCorpusJsonl(corpusText);
		const evaluationConfig = evaluationEnvSchema.parse(process.env);
		const keys = windows.flatMap(window => (["two_stage", "one_pass"] as const).map(strategy => ({ strategy, key: bakeoffCacheKey(window, evaluationConfig, strategy) })));
		const existing = new Set<string>();
		for (const { strategy, key } of keys) {
			const blob = container.getBlobClient(`${prefix}bakeoff-cache/${key}.json`);
			if (!await blob.exists()) continue;
			const content = await streamText((await blob.download()).readableStreamBody);
			if (!validBakeoffCacheEntry(content, strategy)) continue;
			existing.add(key);
			await writeFile(join(cacheDirectory, `${key}.json`), content, { mode: 0o600 });
		}
		const report = assertAggregateBakeoffReport(await runBakeoff(windows, evaluationConfig, { cacheDirectory, full: cli.full }));
		for (const file of await readdir(cacheDirectory)) {
			if (!file.endsWith(".json") || existing.has(file.slice(0, -5))) continue;
			await container.getBlockBlobClient(`${prefix}bakeoff-cache/${file}`).uploadData(await readFile(join(cacheDirectory, file)), {
				blobHTTPHeaders: { blobContentType: "application/json", blobCacheControl: "no-store" }, conditions: { ifNoneMatch: "*" },
			});
		}
		const reportContent = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
		const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
		const beforePublish = await manifestBlob.getProperties();
		if (!blobEtagsEqual(beforePublish.etag, manifestDownload.etag)) throw new Error("Current corpus manifest changed during the bakeoff.");
		await store.publishEvaluationReports(manifest, `bakeoff-${runId}`, [{ extension: "json", content: reportContent }]);
		const currentManifest = await manifestBlob.getProperties();
		if (!blobEtagsEqual(currentManifest.etag, manifestDownload.etag)) throw new Error("Current corpus manifest changed during the bakeoff.");
		console.log(JSON.stringify({ runId, corpusWindows: windows.length, strategies: 2, report: "aggregate-only" }));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
