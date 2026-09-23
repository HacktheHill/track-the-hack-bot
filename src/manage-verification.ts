import { config as loadDotEnv } from "dotenv";
import { z } from "zod";
import { VerificationStore } from "./verification-store.js";

const discordIdSchema = z.string().regex(/^\d{17,20}$/, "Discord IDs must be 17 to 20 digits");
const hackerIdSchema = z
	.string()
	.min(22)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/, "Participant IDs must use URL-safe opaque characters")
	.refine(id => !/^\d+$/.test(id), "Participant IDs must not be sequential numeric values");

export type VerificationMaintenanceCommand =
	| { command: "cleanup" }
	| { command: "unlink"; selector: { discordId: string } | { hackerId: string } }
	| { command: "reset" };

export const parseVerificationMaintenanceArguments = (args: string[]): VerificationMaintenanceCommand => {
	const [command, ...options] = args;
	if (command === "cleanup" && options.length === 0) return { command };
	if (command === "unlink" && options.length === 2) {
		if (options[0] === "--discord-id") {
			return { command, selector: { discordId: discordIdSchema.parse(options[1]) } };
		}
		if (options[0] === "--hacker-id") {
			return { command, selector: { hackerId: hackerIdSchema.parse(options[1]) } };
		}
	}
	if (command === "reset" && options.length === 1 && options[0] === "--confirm-current-event-reset") {
		return { command };
	}
	throw new Error(
		"Usage: verification:manage cleanup | unlink (--discord-id ID | --hacker-id ID) | reset --confirm-current-event-reset",
	);
};

export const runVerificationMaintenance = async (args: string[]) => {
	loadDotEnv();
	if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
	const input = parseVerificationMaintenanceArguments(args);
	const store = new VerificationStore(process.env.DATABASE_URL);
	try {
		if (input.command === "cleanup") {
			return { challenges: await store.cleanupExpiredChallenges() };
		}
		if (input.command === "unlink") return store.unlinkParticipant(input.selector);
		return store.resetParticipantLinks();
	} finally {
		await store.close();
	}
};

if (process.argv[1]?.endsWith("manage-verification.js")) {
	try {
		console.log(JSON.stringify(await runVerificationMaintenance(process.argv.slice(2))));
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Verification maintenance failed");
		process.exitCode = 1;
	}
}
