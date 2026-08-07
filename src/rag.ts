import type { IntegrationConfig } from "./config.js";
import { Database } from "./database.js";
import { AzureEmbeddingClient, embeddingContentHash } from "./embeddings.js";
import { OpenProjectClient, type WorkPackage } from "./openproject.js";
import type { RagRerankCandidate, RagRerankResult } from "./azure-openai.js";

export function resolveProposedAction(
	action: "create" | "update" | "complete" | "reopen",
	_hasTarget: boolean,
) {
	if (action === "create") return "create" as const;
	return action;
}

export function explicitWorkPackageId(texts: readonly string[], openProjectBaseUrl?: string) {
	const allowedOrigin = openProjectBaseUrl ? new URL(openProjectBaseUrl).origin : undefined;
	for (const text of texts) {
		const urls = text.match(/https?:\/\/[^\s>]+/gi) ?? [];
		const urlId = urls.map(value => {
			try {
				const url = new URL(value);
				if (allowedOrigin && url.origin !== allowedOrigin) return undefined;
				return /\/work_packages\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
			} catch { return undefined; }
		}).find(Boolean);
		const reference = /\b(?:task|ticket|work package|issue)\s*#(\d+)\b/i.exec(text);
		const value = urlId ?? reference?.[1];
		if (value) return Number(value);
	}
	return undefined;
}

type ProposalAction = "create" | "update" | "complete" | "reopen";
type TargetMatch = { workPackageId: number; similarity: number };
export type AssessedRagCandidate = {
	workPackageId: number;
	projectId: number;
	lockVersion: number;
	subject: string;
	similarity: number;
	retrievalRank: number;
	relationship: "same_work" | "related";
	confidence: number;
};
export type RagAssessment = {
	candidates: AssessedRagCandidate[];
	recommendedMatch?: TargetMatch;
	latencyMs: number;
	usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
	telemetry: Record<string, unknown>;
};
type RagReranker = {
	assessRagCandidates(query: { title: string; description: string }, candidates: RagRerankCandidate[]): Promise<RagRerankResult>;
};

const RAG_RECOMMENDATION_CONFIDENCE = 0.8;
const RAG_RECOMMENDATION_MARGIN = 0.15;
const RAG_DISPLAY_CONFIDENCE = 0.6;

function workPackageProjectId(workPackage?: WorkPackage) {
	return (workPackage?.project?.id ?? Number(workPackage?._links.project?.href.split("/").at(-1))) || undefined;
}

export async function resolveProposalTarget(options: {
	action: ProposalAction;
	sourceTexts: readonly string[];
	openProjectBaseUrl: string;
	projectId?: number;
	ragMode: IntegrationConfig["OPENPROJECT_RAG_MODE"];
	suggestedMatch?: TargetMatch;
	sourceLinkedTargetId?: number;
	workPackage: (id: number) => Promise<WorkPackage>;
}) {
	const explicitTargetId = explicitWorkPackageId(options.sourceTexts, options.openProjectBaseUrl);
	if (options.action === "create" && !options.sourceLinkedTargetId && !explicitTargetId) return { action: "create" as const, projectId: options.projectId };
	let match: TargetMatch | undefined;
	let target: WorkPackage | undefined;
	let projectId = options.projectId;
	const authoritativeTargetId = explicitTargetId ?? options.sourceLinkedTargetId;
	if (authoritativeTargetId !== undefined) {
		target = await options.workPackage(authoritativeTargetId).catch(() => undefined);
		const targetProjectId = workPackageProjectId(target);
		if (target && targetProjectId) {
			match = { workPackageId: target.id, similarity: 1 };
			projectId = targetProjectId;
		} else {
			target = undefined;
		}
	} else if (options.ragMode === "review" && options.suggestedMatch) {
		match = options.suggestedMatch;
		target = await options.workPackage(match.workPackageId).catch(() => undefined);
		const targetProjectId = workPackageProjectId(target);
		if (!targetProjectId) {
			match = undefined;
			target = undefined;
		} else {
			projectId = targetProjectId;
		}
	}
	const requestedAction = authoritativeTargetId && options.action === "create" ? "update" : options.action;
	const action = resolveProposedAction(requestedAction, Boolean(target));
	return { action, projectId, match, target };
}

function descriptionOf(workPackage: WorkPackage) {
	return typeof workPackage.description === "string" ? workPackage.description : workPackage.description?.raw ?? "";
}

export function cleanRetrievalText(value: string) {
	return value
		.replace(/<!--\s*track-the-hack[^>]*-->/gi, "")
		.replace(/^#{1,6}[ \t]+(?:sources?|source conversation|related links?|related references?)[ \t]*\n[\s\S]*?(?=^#{1,6}[ \t]+|(?![\s\S]))/gim, "")
		.replace(/!?\[([^\]]*)\]\((?:https?:\/\/|attachment:)[^)]+\)/gi, "$1")
		.replace(/https?:\/\/[^\s<>)]+/gi, "")
		.replace(/^[ \t]*(?:sources?|related links?|related references?):[ \t]*$/gim, "")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function workPackageRetrievalDescription(workPackage: WorkPackage) {
	const metadata = [
		workPackage._links.type?.title ? `Type: ${workPackage._links.type.title}` : undefined,
		workPackage._links.status?.title ? `Status: ${workPackage._links.status.title}` : `Status: ${workPackage.isClosed ? "Closed" : "Open"}`,
	].filter((value): value is string => Boolean(value));
	const body = cleanRetrievalText(descriptionOf(workPackage));
	return [...metadata, body].filter(Boolean).join("\n\n");
}

export function lexicalTitleSimilarity(left: string, right: string) {
	const stopWords = new Set(["and", "for", "the", "with"]);
	const editWords = new Set(["change", "changed", "edit", "modify", "modified", "revise", "revised", "revision", "update", "updated"]);
	const canonical = (word: string) => {
		if (editWords.has(word)) return "edit";
		if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
		if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
		return word;
	};
	const words = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9]+/g)
		?.filter(word => word.length > 2 && !stopWords.has(word))
		.map(canonical) ?? []);
	const leftWords = words(left);
	const rightWords = words(right);
	if (!leftWords.size || !rightWords.size) return 0;
	const intersection = [...leftWords].filter(word => rightWords.has(word)).length;
	return intersection / new Set([...leftWords, ...rightWords]).size;
}

export class OpenProjectRag {
	constructor(
		private readonly config: IntegrationConfig,
		private readonly db: Database,
		private readonly openProject: OpenProjectClient,
		private readonly embeddings: AzureEmbeddingClient,
		private readonly reranker?: RagReranker,
	) {}

	get enabled() {
		return this.config.OPENPROJECT_RAG_MODE !== "off" && this.embeddings.enabled;
	}

	async sync() {
		if (!this.enabled) return { indexed: 0 };
		try {
			const projectIds = new Set((await this.openProject.projects()).map(project => project.id));
			let indexed = 0;
			for (const projectId of projectIds) {
				const workPackages = await this.openProject.workPackages(projectId, "all");
				const pending: Array<{ workPackage: WorkPackage; description: string; subject: string; contentHash: string }> = [];
				for (const workPackage of workPackages) {
					const description = workPackageRetrievalDescription(workPackage);
					const subject = workPackage.subject;
					const contentHash = embeddingContentHash(subject, description, this.config.AZURE_OPENAI_EMBEDDING_DEPLOYMENT, this.config.AZURE_OPENAI_EMBEDDING_DIMENSIONS);
					if (await this.db.embeddingIsCurrent(workPackage.id, contentHash, workPackage.lockVersion, Boolean(workPackage.isClosed))) continue;
					pending.push({ workPackage, description, subject, contentHash });
				}
				for (let offset = 0; offset < pending.length; offset += 16) {
					const batch = pending.slice(offset, offset + 16);
					const result = await this.embeddings.embed(batch.map(item => `${item.subject}\n\n${item.description}`));
					for (const [index, item] of batch.entries()) {
					await this.db.upsertEmbedding({
						workPackageId: item.workPackage.id, projectId, lockVersion: item.workPackage.lockVersion,
						subject: item.subject, description: item.description, contentHash: item.contentHash,
						isClosed: Boolean(item.workPackage.isClosed),
						model: this.config.AZURE_OPENAI_EMBEDDING_DEPLOYMENT!, dimensions: result.dimensions, embedding: result.embeddings[index],
						});
						indexed++;
					}
				}
				await this.db.deleteEmbeddingsExcept(projectId, workPackages.map(workPackage => workPackage.id));
			}
			await this.db.recordEmbeddingSync();
			return { indexed, projects: projectIds.size };
		} catch (error) {
			await this.db.recordEmbeddingSync((error as Error).message).catch(() => undefined);
			throw error;
		}
	}

	async findSimilar(projectId: number, title: string, description: string, action: "create" | "update" | "complete" | "reopen" = "create") {
		if (!this.enabled) return [];
		const result = await this.embeddings.embed([`${title}\n\n${description}`]);
		const isClosed = action === "reopen";
		const [semantic, lexicalPool] = await Promise.all([
			this.db.similarEmbeddings(projectId, result.embeddings[0], this.config.AZURE_OPENAI_EMBEDDING_DEPLOYMENT!, result.dimensions, isClosed, 20),
			this.db.embeddingTitles(projectId, this.config.AZURE_OPENAI_EMBEDDING_DEPLOYMENT!, result.dimensions, isClosed),
		]);
		const candidates = new Map(semantic.map(item => [item.workPackageId, item]));
		for (const item of lexicalPool) {
			const lexical = lexicalTitleSimilarity(title, item.subject);
			const current = candidates.get(item.workPackageId);
			const similarity = current
				? current.similarity + (1 - current.similarity) * lexical * 0.5
				: lexical;
			if (current || lexical > 0) candidates.set(item.workPackageId, { ...item, similarity });
		}
		return [...candidates.values()].sort((left, right) => right.similarity - left.similarity).slice(0, 5);
	}

	async assessSimilar(projectId: number, title: string, description: string, action: "create" | "update" | "complete" | "reopen" = "create"): Promise<RagAssessment> {
		const started = Date.now();
		try {
			const matches = await this.findSimilar(projectId, title, description, action);
			if (!matches.length || !this.reranker) {
				return { candidates: [], latencyMs: Date.now() - started, telemetry: { outcome: matches.length ? "reranker_unavailable" : "no_candidates", retrievalLatencyMs: Date.now() - started } };
			}
			const reranked = await this.reranker.assessRagCandidates({ title, description }, matches.map(match => ({
				workPackageId: match.workPackageId,
				subject: match.subject,
				description: match.description,
				retrievalScore: match.similarity,
			})));
			const assessments = new Map(reranked.assessments.map(assessment => [assessment.candidate_index, assessment]));
			const assessed = matches.map((match, retrievalRank) => ({ match, retrievalRank, assessment: assessments.get(retrievalRank) }))
				.filter((item): item is typeof item & { assessment: NonNullable<typeof item.assessment> } => Boolean(item.assessment));
			let candidates = assessed
				.filter(item => item.assessment.relationship !== "unrelated" && item.assessment.confidence >= RAG_DISPLAY_CONFIDENCE)
				.sort((left, right) => {
					const relationship = Number(right.assessment.relationship === "same_work") - Number(left.assessment.relationship === "same_work");
					return relationship || right.assessment.confidence - left.assessment.confidence || right.match.similarity - left.match.similarity;
				})
				.slice(0, 3)
				.map(({ match, retrievalRank, assessment }) => ({
					workPackageId: match.workPackageId,
					projectId: match.projectId,
					lockVersion: match.lockVersion,
					subject: match.subject,
					similarity: match.similarity,
					retrievalRank,
					relationship: assessment.relationship as "same_work" | "related",
					confidence: assessment.confidence,
				}));
			const sameWork = candidates.filter(candidate => candidate.relationship === "same_work" && candidate.similarity >= this.config.OPENPROJECT_RAG_SIMILARITY_THRESHOLD);
			const winner = sameWork[0];
			const runnerUp = sameWork[1];
			const recommendedMatch = winner
				&& winner.confidence >= RAG_RECOMMENDATION_CONFIDENCE
				&& (!runnerUp || winner.confidence - runnerUp.confidence >= RAG_RECOMMENDATION_MARGIN)
				? { workPackageId: winner.workPackageId, similarity: winner.similarity }
				: undefined;
			candidates = candidates.map(candidate => ({ ...candidate, recommended: candidate.workPackageId === recommendedMatch?.workPackageId }));
			return {
				candidates,
				recommendedMatch,
				latencyMs: Date.now() - started,
				usage: reranked.usage,
				telemetry: {
					outcome: recommendedMatch ? "recommended" : candidates.length ? "review" : "no_commonality",
					retrievalLatencyMs: Date.now() - started - reranked.latencyMs,
					rerankLatencyMs: reranked.latencyMs,
					rerankerDeployment: reranked.deployment,
					rerankerUsage: reranked.usage,
					results: assessed.map(({ match, retrievalRank, assessment }) => ({
						workPackageId: match.workPackageId, retrievalRank, retrievalScore: match.similarity,
						relationship: assessment.relationship, confidence: assessment.confidence,
					})),
					recommendedWorkPackageId: recommendedMatch?.workPackageId,
				},
			};
		} catch (error) {
			return { candidates: [], latencyMs: Date.now() - started, telemetry: { outcome: "error", latencyMs: Date.now() - started, error: (error as Error).message.slice(0, 300) } };
		}
	}
}
