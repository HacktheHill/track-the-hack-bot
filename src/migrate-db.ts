import { config as loadDotEnv } from "dotenv";
import { loadIntegrationConfig } from "./config.js";
import { Database } from "./database.js";
import { VerificationStore } from "./verification-store.js";

loadDotEnv();
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const verification = new VerificationStore(process.env.DATABASE_URL);
try {
	await verification.migrate();
	console.log("Discord verification database migration completed.");
} finally {
	await verification.close();
}
const config = loadIntegrationConfig();
if (config) {
	const db = new Database(config.DATABASE_URL);
	try {
		await db.migrate(config);
		console.log("OpenProject database migration completed.");
	} finally {
		await db.close();
	}
}
