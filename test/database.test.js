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

test("existing-task proposals persist explicit operations and independent checkpoints", async () => {
	const queries = [];
	const db = databaseWithPool({
		async query(sql, values) {
			queries.push({ sql, values });
			return { rowCount: 1, rows: [{ id: "proposal" }] };
		},
	});
	await db.createProposal({
		channelId: "channel", projectId: 3, title: "Update wording", description: "Add the revisions",
		sourceMessageIds: ["message"], classification: "direct_assignment", modelDeployment: "model",
		action: "update", targetWorkPackageId: 2149, targetLockVersion: 0,
		metadataPatch: { dueDate: "2026-07-31" }, contentOperation: "postComment", contentMarkdown: "- Change wording",
	});
	assert.match(queries[0].sql, /operation_schema_version, metadata_patch, content_operation, content_markdown/);
	assert.deepEqual(queries[0].values.slice(27, 31), [1, '{"dueDate":"2026-07-31"}', "postComment", "- Change wording"]);
	await db.markProposalPatchApplied("proposal", 2);
	await db.markProposalCommentApplied("proposal", 99);
	assert.match(queries[1].sql, /patch_applied_at/);
	assert.match(queries[2].sql, /comment_activity_id/);
});

test("proposal submission and completion persist timing and correction metadata", async () => {
	const queries = [];
	const db = databaseWithPool({
		async query(sql, values) {
			queries.push({ sql, values });
			return { rowCount: 1, rows: [{ id: "proposal" }] };
		},
	});
	assert.equal(await db.claimProposal("proposal", "reviewer"), true);
	const corrections = {
		title: true, description: false, project: false, assignee: false, accountable: false,
		priority: false, size: false, startDate: false, dueDate: true, estimate: false,
	};
	await db.markProposalCreated("proposal", "reviewer", 42, "confirmation", corrections);
	assert.match(queries[0].sql, /review_started_at=COALESCE/);
	assert.match(queries[1].sql, /review_outcome='approved'/);
	assert.deepEqual(queries[1].values[4], corrections);
});

test("existing-task proposal finalization commits status, audit, and revision together", async () => {
	const queries = [];
	const client = {
		async query(sql, values) {
			queries.push({ sql, values });
			if (sql.includes("UPDATE task_proposals")) return { rowCount: 1, rows: [{ revision: 2 }] };
			return { rowCount: null, rows: [] };
		},
		release() {},
	};
	const db = databaseWithPool({ async connect() { return client; } });
	const corrections = {
		title: false, description: false, project: false, assignee: false, accountable: false,
		priority: false, size: false, startDate: false, dueDate: false, estimate: false,
	};
	await db.finalizeProposalUpdate({
		id: "proposal", reviewerId: "reviewer", workPackageId: 42, corrections,
		action: "update", finalSnapshot: { contentOperation: "postComment" },
	});
	assert.equal(queries[0].sql, "BEGIN");
	assert.match(queries[1].sql, /revision=revision \+ 1/);
	assert.match(queries[2].sql, /task_audit_log/);
	assert.match(queries[3].sql, /task_proposal_revisions/);
	assert.equal(queries[4].sql, "COMMIT");
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
		inputSnapshot: [{ id: "message", text: "minimized" }],
		messageAssessments: [{ message_id: "message", relevance: "relevant" }],
		decision: { outcome: "proposal" },
	});
	assert.match(inserted.sql, /ai_extraction_events/);
	assert.deepEqual(inserted.values, ["automatic", "proposal", "model", 1, 250, '{"totalTokens":123}', null, '[{"id":"message","text":"minimized"}]', '[{"message_id":"message","relevance":"relevant"}]', '{"outcome":"proposal"}']);
});

test("proposal delivery failures become retryable failed proposals", async () => {
	let query;
	const db = databaseWithPool({ async query(sql, values) { query = { sql, values }; return { rowCount: 1, rows: [] }; } });
	await db.markProposalDeliveryFailed("proposal", "Discord rejected the message");
	assert.match(query.sql, /status='failed'/);
	assert.match(query.sql, /delivery_failed/);
	assert.deepEqual(query.values, ["proposal", "Discord rejected the message"]);
});

test("proposal claims use an expiring lease", async () => {
	let query;
	const db = databaseWithPool({ async query(sql, values) { query = { sql, values }; return { rowCount: 1, rows: [{ id: "proposal" }] }; } });
	assert.equal(await db.claimProposal("proposal", "reviewer"), true);
	assert.match(query.sql, /claim_expires_at=now\(\) \+ interval '15 minutes'/);
	assert.match(query.sql, /status='creating' AND claim_expires_at < now\(\)/);
});

test("handled proposal revisions use AI evaluation retention instead of proposal expiry", async () => {
	const queries = [];
	const db = databaseWithPool({ async query(sql, values) { queries.push({ sql, values }); return { rowCount: 0, rows: [] }; } });
	await db.cleanup({ OPENPROJECT_PROPOSAL_RETENTION_DAYS: 30, OPENPROJECT_AI_EVALUATION_RETENTION_DAYS: 90, OPENPROJECT_AUDIT_RETENTION_DAYS: 365 });
	assert.match(queries[0].sql, /status='pending_review' AND expires_at/);
	assert.deepEqual(queries[0].values, [90]);
});

test("scheduled messages persist the scheduler identity snapshot", async () => {
	let inserted;
	const db = databaseWithPool({
		async query(sql, values) {
			inserted = { sql, values };
			return { rowCount: 1, rows: [] };
		},
	});
	await db.createScheduledMessage({
		guildId: "guild", channelId: "channel", createdByDiscordId: "user",
		schedulerName: "Display Name", schedulerAvatarUrl: "https://cdn.example/avatar.png",
		content: "Scheduled content", sendAt: new Date("2026-07-17T12:00:00Z"),
	});
	assert.match(inserted.sql, /scheduler_name,scheduler_avatar_url/);
	assert.deepEqual(inserted.values.slice(1, 7), [
		"guild", "channel", "user", "Display Name", "https://cdn.example/avatar.png", "Scheduled content",
	]);
});

test("due scheduled messages are claimed with row locking", async () => {
	let query;
	const db = databaseWithPool({
		async query(sql, values) {
			query = { sql, values };
			return { rowCount: 1, rows: [{ id: "schedule", attempts: 1 }] };
		},
	});
	const claimed = await db.claimDueScheduledMessages(5);
	assert.equal(claimed[0].id, "schedule");
	assert.match(query.sql, /FOR UPDATE SKIP LOCKED/);
	assert.match(query.sql, /status='processing'/);
	assert.deepEqual(query.values, [5]);
});

test("failed scheduled delivery can return to the pending queue", async () => {
	let update;
	const db = databaseWithPool({
		async query(sql, values) {
			update = { sql, values };
			return { rowCount: 1, rows: [] };
		},
	});
	await db.markScheduledMessageDeliveryFailed("schedule", "Discord unavailable", 30);
	assert.match(update.sql, /next_attempt_at/);
	assert.deepEqual(update.values, ["schedule", "pending", "Discord unavailable", 30]);
});
