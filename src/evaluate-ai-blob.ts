import "dotenv/config";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { loadAiCorpusConfig } from "./ai-corpus-config.js";
import { parseCorpusJsonl } from "./ai-corpus.js";
import { AzureBlobCorpusStore } from "./ai-corpus-blob.js";
import { evaluationCacheKey, evaluationEnvSchema } from "./evaluate-ai.js";

async function streamText(stream: NodeJS.ReadableStream | undefined) {
	if (!stream) throw new Error("Blob response did not contain a body.");
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function run(command: string, args: string[], environment: NodeJS.ProcessEnv) {
	return new Promise<void>((resolveRun, reject) => {
		const child = spawn(command, args, { stdio: "inherit", env: environment });
		child.once("error", reject);
		child.once("exit", code => code === 0 ? resolveRun() : reject(new Error(`Evaluation exited with status ${code ?? "unknown"}.`)));
	});
}

async function main() {
	const config = loadAiCorpusConfig();
	const prefix = config.AI_CORPUS_PREFIX ? `${config.AI_CORPUS_PREFIX.replace(/\/$/, "")}/` : "";
	const service = new BlobServiceClient(config.AI_CORPUS_STORAGE_ACCOUNT_URL, new DefaultAzureCredential());
	const container = service.getContainerClient(config.AI_CORPUS_CONTAINER);
	const store = await AzureBlobCorpusStore.create({ accountUrl: config.AI_CORPUS_STORAGE_ACCOUNT_URL, containerName: config.AI_CORPUS_CONTAINER, prefix: config.AI_CORPUS_PREFIX });
	const directory = await mkdtemp(join(tmpdir(), "hth-ai-eval-"));
	const cacheDirectory = join(directory, "cache");
	try {
		await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
		const manifest = z.object({ blobName: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), caseVersions: z.record(z.string(), z.string().min(1)) }).parse(JSON.parse(await streamText((await container.getBlobClient(`${prefix}exports/current-manifest.json`).download()).readableStreamBody)));
		await store.assertExportCurrent(manifest);
		const corpusBlob = container.getBlobClient(manifest.blobName);
		const corpusPath = join(directory, "current.jsonl");
		const corpusText = await streamText((await corpusBlob.download()).readableStreamBody);
		if (createHash("sha256").update(corpusText).digest("hex") !== manifest.sha256) throw new Error("Included corpus digest does not match its manifest.");
		await writeFile(corpusPath, corpusText, { mode: 0o600 });
		const evaluationConfig = evaluationEnvSchema.parse(process.env);
		const cacheKeys = parseCorpusJsonl(corpusText).map(window => evaluationCacheKey(window, evaluationConfig));
		const existing = new Set<string>();
		for (const key of cacheKeys) {
			const blob = container.getBlobClient(`${prefix}cache/${key}.json`);
			if (!await blob.exists()) continue;
			existing.add(key);
			await writeFile(join(cacheDirectory, `${key}.json`), await streamText((await blob.download()).readableStreamBody), { mode: 0o600 });
		}
		const reportPrefix = join(directory, `report-${Date.now()}`);
		await run(process.execPath, [resolve("dist/evaluate-ai.js"), corpusPath, reportPrefix, "--full"], { ...process.env, AI_EVAL_CACHE_DIR: cacheDirectory });
		for (const file of await readdir(cacheDirectory)) {
			if (!file.endsWith(".json")) continue;
			if (existing.has(file.slice(0, -5))) continue;
			await container.getBlockBlobClient(`${prefix}cache/${file}`).uploadData(await readFile(join(cacheDirectory, file)), {
				blobHTTPHeaders: { blobContentType: "application/json", blobCacheControl: "no-store" },
			});
		}
		const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
		await store.publishEvaluationReports(manifest, runId, await Promise.all((["json", "md"] as const).map(async extension => ({ extension, content: await readFile(`${reportPrefix}.${extension}`) }))));
		console.log(JSON.stringify({ runId, corpus: manifest.blobName, reports: 2, cacheHitsAvailable: existing.size }));
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
