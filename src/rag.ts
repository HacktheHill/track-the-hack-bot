import type { IntegrationConfig } from "./config.js";
import { Database } from "./database.js";
import { AzureEmbeddingClient, embeddingContentHash } from "./embeddings.js";
import { OpenProjectClient, type WorkPackage } from "./openproject.js";

export function resolveProposedAction(
	action: "create" | "update" | "complete" | "reopen",
	hasTarget: boolean,
) {
	if (action === "create") return "create" as const;
	return hasTarget ? action : "no_action" as const;
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
	workPackage: (id: number) => Promise<WorkPackage>;
}) {
	if (options.action === "create") return { action: "create" as const, projectId: options.projectId };
	const explicitTargetId = explicitWorkPackageId(options.sourceTexts, options.openProjectBaseUrl);
	let match: TargetMatch | undefined;
	let target: WorkPackage | undefined;
	let projectId = options.projectId;
	if (explicitTargetId !== undefined) {
		target = await options.workPackage(explicitTargetId).catch(() => undefined);
		const targetProjectId = workPackageProjectId(target);
		if (target && targetProjectId && (!projectId || targetProjectId === projectId)) {
			match = { workPackageId: target.id, similarity: 1 };
			projectId = targetProjectId;
		} else {
			target = undefined;
		}
	} else if (options.ragMode === "review" && options.suggestedMatch) {
		match = options.suggestedMatch;
		target = await options.workPackage(match.workPackageId);
		const targetProjectId = workPackageProjectId(target);
		if (!targetProjectId || (projectId && targetProjectId !== projectId)) {
			match = undefined;
			target = undefined;
		} else {
			projectId = targetProjectId;
		}
	}
	return { action: resolveProposedAction(options.action, Boolean(target)), projectId, match, target };
}

function descriptionOf(workPackage: WorkPackage) {
	return typeof workPackage.description === "string" ? workPackage.description : workPackage.description?.raw ?? "";
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
	) {}

	get enabled() {
		return this.config.OPENPROJECT_RAG_MODE !== "off" && this.embeddings.enabled;
	}

	async sync() {
		if (!this.enabled) return { indexed: 0 };
		try {
			const projectIds = new Set([
				...Object.values(this.config.categoryProjects),
				...Object.values(this.config.teamRoles).map(mapping => mapping.projectId),
				...await this.db.categoryProjectIds(),
			]);
			let indexed = 0;
			for (const projectId of projectIds) {
				const workPackages = await this.openProject.workPackages(projectId);
				const pending: Array<{ workPackage: WorkPackage; description: string; subject: string; contentHash: string }> = [];
				for (const workPackage of workPackages) {
					const description = descriptionOf(workPackage);
					const subject = workPackage.subject;
					const contentHash = embeddingContentHash(subject, description);
					if (await this.db.embeddingIsCurrent(workPackage.id, contentHash, workPackage.lockVersion)) continue;
					pending.push({ workPackage, description, subject, contentHash });
				}
				for (let offset = 0; offset < pending.length; offset += 16) {
					const batch = pending.slice(offset, offset + 16);
					const result = await this.embeddings.embed(batch.map(item => `${item.subject}\n\n${item.description}`));
					for (const [index, item] of batch.entries()) {
						await this.db.upsertEmbedding({
							workPackageId: item.workPackage.id, projectId, lockVersion: item.workPackage.lockVersion,
							subject: item.subject, description: item.description, contentHash: item.contentHash,
							model: result.model, dimensions: result.dimensions, embedding: result.embeddings[index],
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

	async findSimilar(projectId: number, title: string, description: string) {
		if (!this.enabled) return [];
		const result = await this.embeddings.embed([`${title}\n\n${description}`]);
		const [semantic, lexicalPool] = await Promise.all([
			this.db.similarEmbeddings(projectId, result.embeddings[0], 20),
			this.db.embeddingTitles(projectId),
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
}
