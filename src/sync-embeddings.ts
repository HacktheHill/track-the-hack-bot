import { config as loadDotEnv } from "dotenv";
import { loadIntegrationConfig } from "./config.js";
import { Database } from "./database.js";
import { AzureEmbeddingClient } from "./embeddings.js";
import { OpenProjectClient } from "./openproject.js";
import { OpenProjectRag } from "./rag.js";

loadDotEnv();
const config = loadIntegrationConfig();
if (!config) throw new Error("OpenProject integration configuration is incomplete.");
if (config.OPENPROJECT_RAG_MODE === "off") throw new Error("Set OPENPROJECT_RAG_MODE to shadow or review before syncing embeddings.");
const db = new Database(config.DATABASE_URL);
const openProject = new OpenProjectClient(config);
const rag = new OpenProjectRag(config, db, openProject, new AzureEmbeddingClient(config));
try {
	if (config.OPENPROJECT_RUN_MIGRATIONS) await db.migrate(config);
	console.log(JSON.stringify(await rag.sync()));
} finally {
	await db.close();
}
