import { config as loadDotEnv } from "dotenv";
import { loadIntegrationConfig } from "./config.js";
import { Database } from "./database.js";

loadDotEnv();
const config = loadIntegrationConfig();
if (!config) throw new Error("OpenProject integration configuration is incomplete.");
const db = new Database(config.DATABASE_URL);
try {
	await db.migrate(config);
	console.log("Database migration completed.");
} finally {
	await db.close();
}
