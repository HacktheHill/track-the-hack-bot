import assert from "node:assert/strict";
import test from "node:test";
import { cleanRetrievalText, OpenProjectRag, workPackageRetrievalDescription } from "../dist/rag.js";

test("RAG retrieval documents remove managed noise and retain stable metadata", () => {
	const description = workPackageRetrievalDescription({
		id: 42,
		subject: "Publish prospectus",
		lockVersion: 3,
		description: { raw: "Review the [prospectus](https://docs.example/prospectus).\n\n## Source conversation\n\nhttps://discord.com/channels/1/2/3\n\n<!-- track-the-hack-proposal:abc:description -->" },
		isClosed: false,
		_links: {
			type: { href: "/api/v3/types/1", title: "Task" },
			status: { href: "/api/v3/statuses/7", title: "In progress" },
		},
	});
	assert.equal(description, "Type: Task\n\nStatus: In progress\n\nReview the prospectus.");
	assert.equal(cleanRetrievalText("See ![mockup](attachment:image.png) and https://example.com/noise."), "See mockup and");
});

test("RAG sync embeds and stores cleaned retrieval documents", async () => {
	const embedded = [];
	const stored = [];
	const rag = new OpenProjectRag(
		{ OPENPROJECT_RAG_MODE: "shadow", AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "embedding", AZURE_OPENAI_EMBEDDING_DIMENSIONS: 1 },
		{
			embeddingIsCurrent: async () => false,
			upsertEmbedding: async item => stored.push(item), deleteEmbeddingsExcept: async () => {}, recordEmbeddingSync: async () => {},
		},
		{
			projects: async () => [{ id: 7 }],
			workPackages: async () => [{
				id: 42, subject: "Publish prospectus", lockVersion: 3, description: "Draft it.\n\n## Sources\n\nhttps://discord.com/channels/1/2/3",
				isClosed: false, _links: { type: { href: "/api/v3/types/1", title: "Task" }, status: { href: "/api/v3/statuses/1", title: "New" } },
			}],
		},
		{ enabled: true, embed: async documents => { embedded.push(...documents); return { embeddings: [[0.1]], dimensions: 1 }; } },
	);
	assert.deepEqual(await rag.sync(), { indexed: 1, projects: 1 });
	assert.equal(embedded[0], "Publish prospectus\n\nType: Task\n\nStatus: New\n\nDraft it.");
	assert.equal(stored[0].description, "Type: Task\n\nStatus: New\n\nDraft it.");
});
