import assert from "node:assert/strict";
import test from "node:test";
import { Database } from "../dist/database.js";

function databaseWithPool(pool) {
	const db = Object.create(Database.prototype);
	Object.defineProperty(db, "pool", { value: pool });
	return db;
}

test("only one concurrent interaction can claim a creation draft", async () => {
	let status = "pending";
	const db = databaseWithPool({
		async query(sql) {
			if (!sql.includes("UPDATE task_drafts SET status='creating'")) throw new Error(`Unexpected query: ${sql}`);
			if (status !== "pending") return { rowCount: 0, rows: [] };
			status = "creating";
			return { rowCount: 1, rows: [{ id: "draft" }] };
		},
	});

	const claims = await Promise.all([
		db.claimDraft("draft", "user", "creation"),
		db.claimDraft("draft", "user", "creation"),
	]);
	assert.deepEqual(claims.sort(), [false, true]);
});

test("manual ambiguous drafts can be reconciled transactionally", async () => {
	let status = "needs_reconciliation";
	const queries = [];
	const client = {
		async query(sql, values) {
			queries.push({ sql, values });
			if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: null, rows: [] };
			if (sql.includes("UPDATE task_proposals")) return { rowCount: 0, rows: [] };
			if (sql.includes("UPDATE task_drafts")) {
				if (status !== "needs_reconciliation") return { rowCount: 0, rows: [] };
				status = "created";
				return { rowCount: 1, rows: [{ id: "draft" }] };
			}
			if (sql.includes("INSERT INTO task_audit_log")) return { rowCount: 1, rows: [] };
			throw new Error(`Unexpected query: ${sql}`);
		},
		release() {},
	};
	const db = databaseWithPool({ async connect() { return client; } });

	await db.reconcileCreation("draft", "organizer", 42);
	assert.equal(status, "created");
	assert.equal(queries.some(({ sql }) => sql === "COMMIT"), true);
	assert.equal(queries.some(({ sql }) => sql.includes("openproject_work_package_id,event")), true);
});
