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

test("a retry-safe failure releases a claimed draft", async () => {
	let status = "pending";
	const db = databaseWithPool({
		async query(sql) {
			if (sql.includes("SET status='creating'")) {
				if (status !== "pending") return { rowCount: 0, rows: [] };
				status = "creating";
				return { rowCount: 1, rows: [{ id: "draft" }] };
			}
			if (sql.includes("SET status='pending'")) {
				if (status === "creating") status = "pending";
				return { rowCount: 1, rows: [] };
			}
			throw new Error(`Unexpected query: ${sql}`);
		},
	});
	assert.equal(await db.claimDraft("draft", "user", "creation"), true);
	await db.releaseDraft("draft", "assignee is not mapped", 1440);
	assert.equal(await db.claimDraft("draft", "user", "creation"), true);
});

test("reading an in-progress draft does not delete it", async () => {
	const queries = [];
	const db = databaseWithPool({
		async query(sql) {
			queries.push(sql);
			return { rowCount: 1, rows: [{ payload: {}, status: "creating", error: null, expires_at: "2099-01-01T00:00:00Z" }] };
		},
	});
	await assert.rejects(db.draft("draft", "user", "creation"), /currently being handled/);
	assert.equal(queries.some(sql => sql.includes("DELETE FROM task_drafts")), false);
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

test("AI proposal metadata is persisted for reviewed task creation", async () => {
	let inserted;
	const db = databaseWithPool({
		async query(sql, values) {
			inserted = { sql, values };
			return { rowCount: 1, rows: [{ id: "proposal" }] };
		},
	});
	await db.createProposal({
		channelId: "channel", projectId: 3, title: "Prepare outreach", description: "Create the tracker",
		assigneeDiscordId: "user", accountableDiscordId: "accountable", priorityId: 4, sizeHref: "/api/v3/custom_options/5",
		startDate: "2026-07-14", dueDate: "2026-07-21", estimatedHours: 6,
		sourceMessageIds: ["message"], classification: "direct_assignment", modelDeployment: "model",
	});
	assert.match(inserted.sql, /priority_id, size_href, start_date, due_date, estimated_hours/);
	assert.deepEqual(inserted.values.slice(7, 13), ["accountable", 4, "/api/v3/custom_options/5", "2026-07-14", "2026-07-21", 6]);
});

test("proposal review start and completion persist timing and correction metadata", async () => {
	const queries = [];
	const db = databaseWithPool({
		async query(sql, values) {
			queries.push({ sql, values });
			return { rowCount: 1, rows: [{ id: "proposal" }] };
		},
	});
	assert.equal(await db.startProposalReview("proposal", "reviewer"), true);
	const corrections = {
		title: true, description: false, project: false, assignee: false, accountable: false,
		priority: false, size: false, startDate: false, dueDate: true, estimate: false,
	};
	await db.markProposalCreated("proposal", "reviewer", 42, "confirmation", corrections);
	assert.match(queries[0].sql, /review_started_at=COALESCE/);
	assert.match(queries[1].sql, /review_outcome='approved'/);
	assert.deepEqual(queries[1].values[4], corrections);
});

test("extraction events retain structured metrics but no message content", async () => {
	let inserted;
	const db = databaseWithPool({
		async query(sql, values) {
			inserted = { sql, values };
			return { rowCount: 1, rows: [] };
		},
	});
	await db.recordExtraction({
		source: "automatic", outcome: "proposal", modelDeployment: "model",
		taskCount: 1, latencyMs: 250, tokenUsage: { totalTokens: 123 },
	});
	assert.match(inserted.sql, /ai_extraction_events/);
	assert.deepEqual(inserted.values, ["automatic", "proposal", "model", 1, 250, { totalTokens: 123 }, null, null, null, null]);
});
