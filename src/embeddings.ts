import { createHash } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import type { IntegrationConfig } from "./config.js";

export type EmbeddingClientResult = { embeddings: number[][]; model: string; dimensions: number };

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENETDOWN", "ENETUNREACH"]);

function retryDelayMs(response: Response, attempt: number) {
	const milliseconds = response.headers.get("retry-after-ms") ?? response.headers.get("x-ms-retry-after-ms");
	if (milliseconds !== null) {
		const value = Number(milliseconds);
		if (Number.isFinite(value)) return Math.min(60_000, Math.max(0, value));
	}
	const retryAfter = response.headers.get("retry-after");
	if (retryAfter !== null) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(0, seconds * 1000));
		const date = Date.parse(retryAfter);
		if (Number.isFinite(date)) return Math.min(60_000, Math.max(0, date - Date.now()));
	}
	return Math.min(1_000 * 2 ** attempt, 60_000);
}

function isTransientNetworkError(error: unknown) {
	if (error instanceof DOMException && error.name === "AbortError") return false;
	if (error instanceof TypeError) return true;
	const candidate = error as { code?: unknown; cause?: { code?: unknown } };
	const code = typeof candidate?.code === "string" ? candidate.code : candidate?.cause?.code;
	return typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code);
}

export class AzureEmbeddingClient {
	private readonly tokenProvider: () => Promise<string>;

	constructor(
		private readonly config: IntegrationConfig,
		tokenProvider?: () => Promise<string>,
		private readonly sleep: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
	) {
		const credential = new DefaultAzureCredential();
		this.tokenProvider = tokenProvider ?? (async () => (await credential.getToken("https://cognitiveservices.azure.com/.default")).token);
	}

	get enabled() {
		return Boolean(this.config.AZURE_OPENAI_ENDPOINT && this.config.AZURE_OPENAI_EMBEDDING_DEPLOYMENT && this.config.AZURE_OPENAI_EMBEDDING_DIMENSIONS);
	}

	async embed(input: string[]) : Promise<EmbeddingClientResult> {
		const deployment = this.config.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;
		const dimensions = this.config.AZURE_OPENAI_EMBEDDING_DIMENSIONS;
		if (!this.config.AZURE_OPENAI_ENDPOINT || !deployment || !dimensions) throw new Error("Azure OpenAI embeddings are not configured.");
		const endpoint = this.config.AZURE_OPENAI_ENDPOINT.replace(/\/$/, "");
		const url = this.config.AZURE_OPENAI_API_VERSION === "v1"
			? `${endpoint}/openai/v1/embeddings`
			: `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/embeddings?api-version=${encodeURIComponent(this.config.AZURE_OPENAI_API_VERSION)}`;
		let response: Response | undefined;
		for (let attempt = 0; attempt < 5; attempt++) {
			const token = await this.tokenProvider();
			try {
				response = await fetch(url, {
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
					body: JSON.stringify({ model: deployment, input, dimensions }),
				});
			} catch (error) {
				if (!isTransientNetworkError(error) || attempt === 4) throw error;
				await this.sleep(Math.min(1_000 * 2 ** attempt, 60_000));
				continue;
			}
			if (!RETRYABLE_STATUSES.has(response.status) || attempt === 4) break;
			const delayMs = retryDelayMs(response, attempt);
			await response.body?.cancel().catch(() => undefined);
			await this.sleep(delayMs);
		}
		if (!response) throw new Error("Azure embeddings request did not return a response.");
		if (!response.ok) throw new Error(`Azure embeddings ${response.status}: ${(await response.text()).slice(0, 300)}`);
		const json = await response.json() as { data?: Array<{ embedding?: number[]; index?: number }>; model?: string };
		const embeddings = [...(json.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0)).map(item => item.embedding ?? []);
		if (embeddings.length !== input.length || embeddings.some(vector => vector.length !== dimensions)) throw new Error("Azure embeddings returned an unexpected vector dimension.");
		return { embeddings, model: json.model ?? deployment, dimensions };
	}
}

export function embeddingContentHash(subject: string, description: string, model = "", dimensions?: number) {
	return createHash("sha256").update(`work-package-v2\n${model}\n${dimensions ?? ""}\n${subject}\n\n${description}`).digest("hex");
}
