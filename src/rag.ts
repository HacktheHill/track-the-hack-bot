import type { IntegrationConfig } from "./config.js";
import { Database } from "./database.js";
import { AzureEmbeddingClient, embeddingContentHash } from "./embeddings.js";
import { OpenProjectClient, type WorkPackage } from "./openproject.js";

export function resolveProposedAction(
	action: "create" | "update" | "complete" | "reopen" | "no_action",
	ragMode: IntegrationConfig["OPENPROJECT_RAG_MODE"],
	hasMatch: boolean,
) {
	if (action === "no_action") return "no_action" as const;
	if (action === "create") return ragMode === "review" && hasMatch ? "update" as const : "create" as const;
	return ragMode === "review" && hasMatch ? action : "no_action" as const;
}

function descriptionOf(workPackage: WorkPackage) {
	return typeof workPackage.description === "string" ? workPackage.description : workPackage.description?.raw ?? "";
}

export function lexicalTitleSimilarity(left: string, right: string) {
	const stopWords = new Set(["and", "for", "the", "with"]);
	const words = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9]+/g)?.filter(word => word.length > 2 && !stopWords.has(word)) ?? []);
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
				? current.similarity + (1 - current.similarity) * lexical * 0.25
				: lexical;
			if (current || lexical > 0) candidates.set(item.workPackageId, { ...item, similarity });
		}
		return [...candidates.values()].sort((left, right) => right.similarity - left.similarity).slice(0, 5);
	}
}
