import { createHash } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import type { IntegrationConfig } from "./config.js";

export type EmbeddingClientResult = { embeddings: number[][]; model: string; dimensions: number };

export class AzureEmbeddingClient {
	private readonly tokenProvider: () => Promise<string>;

	constructor(private readonly config: IntegrationConfig, tokenProvider?: () => Promise<string>) {
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
			response = await fetch(url, {
				method: "POST",
				headers: { Authorization: `Bearer ${await this.tokenProvider()}`, "Content-Type": "application/json" },
				body: JSON.stringify({ model: deployment, input, dimensions }),
			});
			if (response.status !== 429 && response.status < 500) break;
			const retryAfter = Number(response.headers.get("retry-after"));
			const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
				? Math.min(retryAfter * 1000, 60_000)
				: Math.min(1_000 * 2 ** attempt, 60_000);
			await new Promise(resolve => setTimeout(resolve, delayMs));
		}
		if (!response) throw new Error("Azure embeddings request did not return a response.");
		if (!response.ok) throw new Error(`Azure embeddings ${response.status}: ${(await response.text()).slice(0, 300)}`);
		const json = await response.json() as { data?: Array<{ embedding?: number[]; index?: number }>; model?: string };
		const embeddings = [...(json.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0)).map(item => item.embedding ?? []);
		if (embeddings.length !== input.length || embeddings.some(vector => vector.length !== dimensions)) throw new Error("Azure embeddings returned an unexpected vector dimension.");
		return { embeddings, model: json.model ?? deployment, dimensions };
	}
}

export function embeddingContentHash(subject: string, description: string) {
	return createHash("sha256").update(`${subject}\n\n${description}`).digest("hex");
}
