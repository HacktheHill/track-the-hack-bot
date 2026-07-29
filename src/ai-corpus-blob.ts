import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { createHash, randomUUID } from "node:crypto";
import { corpusCaseSchema, corpusJsonl, type CorpusCase } from "./ai-corpus.js";

export type CorpusCaseSummary = {
	id: string;
	status: CorpusCase["adjudication"]["status"];
	originType: CorpusCase["origin"]["type"];
	updatedAt: string;
	messageCount: number;
	proposalCount: number;
	preview: string;
};

export type CorpusExportManifest = {
	schemaVersion: "v1";
	generatedAt: string;
	caseCount: number;
	positiveCases: number;
	negativeCases: number;
	sha256: string;
	blobName: string;
	caseVersions: Record<string, string>;
};

export interface CorpusStore {
	listCases(): Promise<CorpusCaseSummary[]>;
	getCase(id: string): Promise<{ case: CorpusCase; etag: string }>;
	putCase(value: CorpusCase, etag?: string): Promise<{ etag: string }>;
	exportApproved(): Promise<CorpusExportManifest>;
	getExportManifest(): Promise<CorpusExportManifest | null>;
}

function safeSegment(value: string) {
	if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error("Corpus case ID contains unsupported characters.");
	return value;
}

async function bodyText(body: NodeJS.ReadableStream | undefined) {
	if (!body) throw new Error("Blob response did not contain a body.");
	const chunks: Buffer[] = [];
	for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

export class AzureBlobCorpusStore implements CorpusStore {
	private constructor(private readonly container: ContainerClient, private readonly prefix: string) {}

	static async create(options: { accountUrl: string; containerName: string; prefix?: string; createContainer?: boolean }) {
		const service = new BlobServiceClient(options.accountUrl.replace(/\/$/, ""), new DefaultAzureCredential());
		const container = service.getContainerClient(options.containerName);
		if (options.createContainer) await container.createIfNotExists();
		return new AzureBlobCorpusStore(container, (options.prefix ?? "").replace(/^\/+|\/+$/g, ""));
	}

	private name(path: string) {
		return this.prefix ? `${this.prefix}/${path}` : path;
	}

	private caseBlob(id: string) {
		return this.container.getBlockBlobClient(this.name(`cases/${safeSegment(id)}.json`));
	}

	private async withExportLock<T>(operation: () => Promise<T>) {
		const lockBlob = this.container.getBlockBlobClient(this.name("system/export.lock"));
		await lockBlob.uploadData(Buffer.alloc(0), {
			conditions: { ifNoneMatch: "*" },
			blobHTTPHeaders: { blobContentType: "application/octet-stream", blobCacheControl: "no-store" },
		}).catch(error => {
			if (statusCode(error) !== 409 && statusCode(error) !== 412) throw error;
		});
		const deadline = Date.now() + 30_000;
		while (true) {
			const lease = lockBlob.getBlobLeaseClient(randomUUID());
			try {
				await lease.acquireLease(60);
			} catch (error) {
				if (statusCode(error) !== 409 || Date.now() >= deadline) throw error;
				await new Promise(resolve => setTimeout(resolve, 250));
				continue;
			}
			let renewalError: unknown;
			const renewal = setInterval(() => void lease.renewLease().catch(error => { renewalError = error; }), 20_000);
			try {
				const result = await operation();
				if (renewalError) throw renewalError;
				return result;
			} finally {
				clearInterval(renewal);
				await lease.releaseLease().catch(() => undefined);
			}
		}
	}

	private metadata(value: CorpusCase) {
		return {
			status: value.adjudication.status,
			origin: value.origin.type,
			updated: value.updatedAt,
			messages: String(value.window.messages.length),
			proposals: String(value.window.expected.proposals.length),
			preview: encodeURIComponent(value.window.messages.find(message => message.contextRole === "primary" || message.priority)?.text.slice(0, 180) ?? value.window.messages[0]?.text.slice(0, 180) ?? ""),
		};
	}

	async listCases() {
		const cases: CorpusCaseSummary[] = [];
		for await (const item of this.container.listBlobsFlat({ prefix: this.name("cases/"), includeMetadata: true })) {
			if (!item.name.endsWith(".json")) continue;
			const id = item.name.slice(item.name.lastIndexOf("/") + 1, -5);
			if (item.metadata?.status && item.metadata.origin && item.metadata.updated) {
				cases.push({
					id,
					status: zStatus(item.metadata.status),
					originType: zOrigin(item.metadata.origin),
					updatedAt: item.metadata.updated,
					messageCount: Number(item.metadata.messages ?? 0),
					proposalCount: Number(item.metadata.proposals ?? 0),
					preview: decodeURIComponent(item.metadata.preview ?? ""),
				});
				continue;
			}
			const blob = this.container.getBlobClient(item.name);
			const value = corpusCaseSchema.parse(JSON.parse(await bodyText((await blob.download()).readableStreamBody)));
			cases.push({
				id: value.id,
				status: value.adjudication.status,
				originType: value.origin.type,
				updatedAt: value.updatedAt,
				messageCount: value.window.messages.length,
				proposalCount: value.window.expected.proposals.length,
				preview: value.window.messages.find(message => message.contextRole === "primary" || message.priority)?.text.slice(0, 180) ?? value.window.messages[0]?.text.slice(0, 180) ?? "",
			});
			await blob.setMetadata(this.metadata(value), { conditions: item.properties.etag ? { ifMatch: item.properties.etag } : undefined }).catch(() => undefined);
		}
		return cases.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}

	async getCase(id: string) {
		const response = await this.caseBlob(id).download();
		const value = corpusCaseSchema.parse(JSON.parse(await bodyText(response.readableStreamBody)));
		if (!response.etag) throw new Error("Corpus case is missing an ETag.");
		return { case: value, etag: response.etag };
	}

	async putCase(value: CorpusCase, etag?: string) {
		const parsed = corpusCaseSchema.parse(value);
		const write = async () => {
			const response = await this.caseBlob(parsed.id).uploadData(Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`), {
				blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8", blobCacheControl: "no-store" },
				metadata: this.metadata(parsed),
				conditions: etag ? { ifMatch: etag } : { ifNoneMatch: "*" },
			});
			if (!response.etag) throw new Error("Corpus case write did not return an ETag.");
			if (etag) await this.invalidateApprovedExportsUnlocked();
			return { etag: response.etag };
		};
		return etag ? this.withExportLock(write) : write();
	}

	async deleteCase(id: string) {
		await this.withExportLock(async () => {
			const result = await this.caseBlob(id).deleteIfExists({ deleteSnapshots: "include" });
			if (result.succeeded) await this.invalidateApprovedExportsUnlocked();
		});
	}

	async invalidateApprovedExports() {
		await this.withExportLock(() => this.invalidateApprovedExportsUnlocked());
	}

	private async invalidateApprovedExportsUnlocked() {
		await this.container.getBlobClient(this.name("exports/current-manifest.json")).deleteIfExists({ deleteSnapshots: "include" });
		for await (const item of this.container.listBlobsFlat({ prefix: this.name("exports/snapshots/") })) {
			await this.container.getBlobClient(item.name).deleteIfExists({ deleteSnapshots: "include" });
		}
		for await (const item of this.container.listBlobsFlat({ prefix: this.name("reports/") })) {
			await this.container.getBlobClient(item.name).deleteIfExists({ deleteSnapshots: "include" });
		}
	}

	private async approvedCaseVersions() {
		const versions: Record<string, string> = {};
		for await (const item of this.container.listBlobsFlat({ prefix: this.name("cases/"), includeMetadata: true })) {
			if (!item.name.endsWith(".json") || item.metadata?.status !== "approved" || !item.properties.etag) continue;
			versions[item.name.slice(item.name.lastIndexOf("/") + 1, -5)] = item.properties.etag;
		}
		return versions;
	}

	private async assertExportCurrentUnlocked(manifest: Pick<CorpusExportManifest, "caseVersions">) {
		const actual = await this.approvedCaseVersions();
		const expected = manifest.caseVersions;
		const ids = new Set([...Object.keys(actual), ...Object.keys(expected)]);
		if ([...ids].some(id => actual[id] !== expected[id])) throw new Error("Approved corpus changed after this export was created.");
	}

	async assertExportCurrent(manifest: Pick<CorpusExportManifest, "caseVersions">) {
		await this.assertExportCurrentUnlocked(manifest);
	}

	async publishEvaluationReports(manifest: Pick<CorpusExportManifest, "caseVersions">, runId: string, reports: Array<{ extension: "json" | "md"; content: Buffer }>) {
		await this.withExportLock(async () => {
			await this.assertExportCurrentUnlocked(manifest);
			for (const report of reports) {
				await this.container.getBlockBlobClient(this.name(`reports/${safeSegment(runId)}/report.${report.extension}`)).uploadData(report.content, {
					blobHTTPHeaders: { blobContentType: report.extension === "json" ? "application/json" : "text/markdown; charset=utf-8", blobCacheControl: "no-store" },
					conditions: { ifNoneMatch: "*" },
				});
			}
		});
	}

	async exportApproved() {
		return this.withExportLock(async () => {
			const summaries = await this.listCases();
			const approved = await Promise.all(summaries.filter(item => item.status === "approved").map(item => this.getCase(item.id)));
			const windows = approved.map(item => item.case.window);
			const jsonl = corpusJsonl(windows);
			const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
			const blobName = this.name(`exports/snapshots/${runId}.jsonl`);
			const manifest: CorpusExportManifest = {
				schemaVersion: "v1",
				generatedAt: new Date().toISOString(),
				caseCount: windows.length,
				positiveCases: windows.filter(window => window.expected.proposals.length > 0).length,
				negativeCases: windows.filter(window => window.expected.proposals.length === 0).length,
				sha256: createHash("sha256").update(jsonl).digest("hex"),
				blobName,
				caseVersions: Object.fromEntries(approved.map(item => [item.case.id, item.etag])),
			};
			await this.container.getBlockBlobClient(blobName).uploadData(Buffer.from(jsonl), {
				blobHTTPHeaders: { blobContentType: "application/x-ndjson; charset=utf-8", blobCacheControl: "no-store" },
				conditions: { ifNoneMatch: "*" },
			});
			const manifestBlob = this.container.getBlockBlobClient(this.name("exports/current-manifest.json"));
			const manifestExists = await manifestBlob.exists();
			const currentEtag = manifestExists ? (await manifestBlob.getProperties()).etag : undefined;
			await manifestBlob.uploadData(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), {
				blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8", blobCacheControl: "no-store" },
				conditions: currentEtag ? { ifMatch: currentEtag } : { ifNoneMatch: "*" },
			});
			return manifest;
		});
	}

	async getExportManifest() {
		const blob = this.container.getBlobClient(this.name("exports/current-manifest.json"));
		if (!await blob.exists()) return null;
		return JSON.parse(await bodyText((await blob.download()).readableStreamBody)) as CorpusExportManifest;
	}
}

function statusCode(error: unknown) {
	return error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined;
}

function zStatus(value: string): CorpusCase["adjudication"]["status"] {
	if (value === "pending" || value === "approved" || value === "rejected") return value;
	throw new Error("Corpus blob has invalid status metadata.");
}

function zOrigin(value: string): CorpusCase["origin"]["type"] {
	if (value === "reviewed_proposal" || value === "sampled_no_task" || value === "manual_scenario") return value;
	throw new Error("Corpus blob has invalid origin metadata.");
}
