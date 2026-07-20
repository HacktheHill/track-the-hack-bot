import assert from "node:assert/strict";
import test from "node:test";
import { Database } from "../dist/database.js";

function databaseWithPool(pool) {
	if (!pool.connect) pool.connect = async () => ({ ...pool, release() {} });
	const db = Object.create(Database.prototype);
	Object.defineProperty(db, "pool", { value: pool });
	return db;
}

test("failed task confirmations retain every owner for retry", async () => {
	let queuedOwners;
	const db = databaseWithPool({
		async query(sql, params) {
			if (sql.includes("INSERT INTO task_confirmation_queue")) {
				queuedOwners = params[2];
				return { rowCount: 1, rows: [] };
			}
			if (sql.includes("SELECT owner_discord_ids")) {
				return { rowCount: 1, rows: [{ owner_discord_ids: queuedOwners }] };
			}
			throw new Error(`Unexpected query: ${sql}`);
		},
	});

	await db.queueConfirmation(42, "channel", ["assignee", "accountable"], "Discord unavailable");
	assert.deepEqual(await db.pendingConfirmation(42), { owner_discord_ids: ["assignee", "accountable"] });
});

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
			if (sql.includes("INSERT INTO task_proposals")) {
				inserted = { sql, values };
				return { rowCount: 1, rows: [{ id: "proposal" }] };
			}
			return { rowCount: 0, rows: [] };
		},
	});
	await db.createProposal({
		channelId: "channel", projectId: 3, title: "Prepare outreach", description: "Create the tracker",
		assigneeDiscordId: "user", accountableDiscordId: "accountable", priorityId: 4, sizeHref: "/api/v3/custom_options/5",
		startDate: "2026-07-14", dueDate: "2026-07-21", estimatedHours: 6,
		metadataInference: { priority: false, size: true, estimate: true },
		sourceMessageIds: ["message"], classification: "direct_assignment", modelDeployment: "model",
	});
	assert.match(inserted.sql, /priority_id, size_href, start_date, due_date, estimated_hours/);
	assert.match(inserted.sql, /\$18,'pending_review',\$19/);
	assert.deepEqual(inserted.values.slice(7, 13), ["accountable", 4, "/api/v3/custom_options/5", "2026-07-14", "2026-07-21", 6]);
	assert.equal(inserted.values[13], '{"priority":false,"size":true,"estimate":true}');
	assert.match(inserted.values[15], /channel:3:message:create:new:user:prepare outreach/);
});

test("existing-task proposals persist explicit operations and independent checkpoints", async () => {
	const queries = [];
	const db = databaseWithPool({
		async query(sql, values) {
			queries.push({ sql, values });
			return sql.includes("INSERT INTO task_proposals") ? { rowCount: 1, rows: [{ id: "proposal" }] } : { rowCount: 0, rows: [] };
		},
	});
	await db.createProposal({
		channelId: "channel", projectId: 3, title: "Update wording", description: "Add the revisions",
		sourceMessageIds: ["message"], classification: "direct_assignment", modelDeployment: "model",
		action: "update", targetWorkPackageId: 2149, targetLockVersion: 0,
		metadataPatch: { dueDate: "2026-07-31" }, contentOperation: "postComment", contentMarkdown: "- Change wording",
	});
	const insert = queries.find(query => query.sql.includes("INSERT INTO task_proposals"));
	assert.match(insert.sql, /operation_schema_version, metadata_patch, content_operation, content_markdown/);
	assert.deepEqual(insert.values.slice(28, 32), [1, '{"dueDate":"2026-07-31"}', "postComment", "- Change wording"]);
	await db.markProposalPatchApplied("proposal", 2);
	await db.markProposalCommentApplied("proposal", 99);
	assert.equal(queries.some(query => query.sql.includes("patch_applied_at")), true);
	assert.equal(queries.some(query => query.sql.includes("comment_activity_id")), true);
});

test("overlapping active proposals deduplicate similar generated titles", async () => {
	const queries = [];
	const db = databaseWithPool({
		async query(sql) {
			queries.push(sql);
			if (sql.includes("SELECT id,title,status,work_item_key")) {
				return { rowCount: 1, rows: [{ id: "existing", title: "Update sponsorship package wording and layout", status: "pending_review", work_item_key: null, source_content_hash: null, revision: 1 }] };
			}
			if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) return { rowCount: 0, rows: [] };
			throw new Error(`Unexpected query: ${sql}`);
		},
	});
	assert.deepEqual(await db.createProposal({
		channelId: "channel", title: "Revise sponsorship package wording and layout", description: "Apply edits",
		sourceMessageIds: ["message"], modelDeployment: "model",
	}), { id: "existing", reused: true, revised: false });
	assert.equal(queries.some(sql => sql.includes("INSERT INTO task_proposals")), false);
	assert.equal(queries.some(sql => sql.includes("expires_at > now()")), true);
});

test("a clarification revises the matching pending work item instead of creating another proposal", async () => {
	const queries = [];
	const db = databaseWithPool({
		async query(sql, values) {
			queries.push({ sql, values });
			if (sql.includes("SELECT id,title,status,work_item_key")) return {
				rowCount: 1,
				rows: [{ id: "existing", title: "Update schema", status: "pending_review", work_item_key: "prisms-schema", source_content_hash: "old", revision: 1 }],
			};
			if (sql.includes("UPDATE task_proposals SET title=")) return { rowCount: 1, rows: [{ revision: 2 }] };
			if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("pg_advisory_xact_lock") || sql.includes("INSERT INTO task_proposal_revisions")) return { rowCount: 1, rows: [] };
			throw new Error(`Unexpected query: ${sql}`);
		},
	});
	assert.deepEqual(await db.createProposal({
		channelId: "channel", title: "Update Prisms schema", description: "Use the clarified fields",
		sourceMessageIds: ["clarification"], sourceLinks: ["https://discord/clarification"], modelDeployment: "model",
		workItemKey: "prisms-schema", sourceContentHash: "new", initialSnapshot: { title: "Update Prisms schema" },
		projectId: 8, assigneeDiscordId: "new-owner", accountableDiscordId: "accountable", dueDate: "2026-08-01",
		action: "update", targetWorkPackageId: 42, targetLockVersion: 5,
		metadataPatch: { dueDate: "2026-08-01" }, contentOperation: "postComment", contentMarkdown: "Clarified fields",
	}), { id: "existing", reused: true, revised: true });
	const revision = queries.find(({ sql }) => sql.includes("source_message_ids=ARRAY"));
	assert.equal(Boolean(revision), true);
	assert.match(revision.sql, /assignee_discord_id=\$11/);
	assert.match(revision.sql, /content_operation=\$30/);
	assert.deepEqual(revision.values.slice(9, 16), [8, "new-owner", "accountable", null, null, null, "2026-08-01"]);
	assert.deepEqual(revision.values.slice(24, 31), ["update", 42, 5, 1, '{"dueDate":"2026-08-01"}', "postComment", "Clarified fields"]);
	assert.equal(queries.some(({ sql }) => sql.includes("'edit'")), true);
});

test("proposal insertion and its initial revision commit atomically", async () => {
	const queries = [];
	const db = databaseWithPool({
		async query(sql) {
			queries.push(sql);
			if (sql.includes("INSERT INTO task_proposals")) return { rowCount: 1, rows: [{ id: "proposal" }] };
			return { rowCount: 0, rows: [] };
		},
	});
	await db.createProposal({
		channelId: "channel", title: "Prepare outreach", description: "Create tracker",
		sourceMessageIds: ["message"], modelDeployment: "model", initialSnapshot: { title: "Prepare outreach" },
	});
	const revisionIndex = queries.findIndex(sql => sql.includes("INSERT INTO task_proposal_revisions"));
	const commitIndex = queries.findIndex(sql => sql === "COMMIT");
	assert.ok(revisionIndex > -1 && commitIndex > revisionIndex);
});

test("existing-task proposals require a target and lock version", async () => {
	const db = databaseWithPool({ async query() { throw new Error("should not query"); } });
	await assert.rejects(db.createProposal({
		channelId: "channel", projectId: 3, title: "Update wording", description: "Add revisions",
		sourceMessageIds: ["message"], modelDeployment: "model", action: "update",
		contentOperation: "postComment", contentMarkdown: "- Change wording",
	}), /require a target task and lock version/);
});

test("reviewers can safely retarget a create proposal as an update", async () => {
	let updated;
	const db = databaseWithPool({
		async query(sql, values) {
			updated = { sql, values };
			return { rowCount: 1, rows: [] };
		},
	});
	await db.convertProposalToUpdate({
		id: "proposal", projectId: 7, targetWorkPackageId: 42, targetLockVersion: 3,
		metadataPatch: {}, contentOperation: "postComment", contentMarkdown: "## Update\n\n- Revise it.",
	});
	assert.match(updated.sql, /action='update'/);
	assert.deepEqual(updated.values, ["proposal", 42, 3, "{}", "postComment", "## Update\n\n- Revise it.", 7]);
});

test("proposal creation finalizes status, audit, and reviewed snapshot atomically", async () => {
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
		title: true, description: false, project: false, assignee: false, accountable: false,
		priority: false, size: false, startDate: false, dueDate: true, estimate: false,
	};
	await db.finalizeProposalCreation({
		id: "proposal", reviewerId: "reviewer", workPackageId: 42,
		confirmationMessageId: "confirmation", corrections, finalSnapshot: { title: "Reviewed" },
	});
	assert.equal(queries[0].sql, "BEGIN");
	assert.match(queries[1].sql, /review_outcome='approved'/);
	assert.match(queries[1].sql, /revision=revision \+ 1/);
	assert.deepEqual(queries[1].values[4], corrections);
	assert.match(queries[2].sql, /task_audit_log/);
	assert.match(queries[3].sql, /task_proposal_revisions/);
	assert.equal(queries[4].sql, "COMMIT");
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
		proposalIds: ["00000000-0000-4000-8000-000000000001"],
	});
	assert.match(inserted.sql, /ai_extraction_events/);
	assert.match(inserted.sql, /schema_version/);
	assert.match(inserted.sql, /'v3'/);
	assert.match(inserted.sql, /task_proposal_extractions/);
	assert.deepEqual(inserted.values, ["automatic", "proposal", "model", 1, 250, '{"totalTokens":123}', null, '[{"id":"message","text":"minimized"}]', '[{"message_id":"message","relevance":"relevant"}]', '{"outcome":"proposal"}', ["00000000-0000-4000-8000-000000000001"]]);
});

test("dismissed proposals require and persist a structured reason", async () => {
	let query;
	const db = databaseWithPool({ async query(sql, values) { query = { sql, values }; return { rowCount: 1, rows: [] }; } });
	await assert.rejects(db.setProposalStatus("proposal", "dismissed", "reviewer"), /dismissal reason is required/);
	assert.equal(await db.setProposalStatus("proposal", "dismissed", "reviewer", "question_or_announcement"), true);
	assert.match(query.sql, /dismissal_reason=\$4/);
	assert.deepEqual(query.values, ["proposal", "dismissed", "reviewer", "question_or_announcement"]);
});

test("proposal delivery failures become retryable failed proposals", async () => {
	let query;
	const db = databaseWithPool({ async query(sql, values) { query = { sql, values }; return { rowCount: 1, rows: [] }; } });
	await db.markProposalDeliveryFailed("proposal", "Discord rejected the message");
	assert.match(query.sql, /status='failed'/);
	assert.match(query.sql, /delivery_failed/);
	assert.deepEqual(query.values, ["proposal", "Discord rejected the message"]);
});

test("proposal review cards attach, clear idempotently, and remain discoverable for terminal cleanup", async () => {
	const queries = [];
	const db = databaseWithPool({
		async query(sql, values) {
			queries.push({ sql, values });
			if (sql.includes("SELECT id,channel_id,review_message_id")) {
				return { rowCount: 1, rows: [{ id: "proposal", channel_id: "channel", review_message_id: "message" }] };
			}
			return { rowCount: 1, rows: [] };
		},
	});
	assert.equal(await db.setProposalReviewMessage("proposal", "message"), true);
	assert.equal(await db.clearProposalReviewMessage("proposal", "message"), true);
	assert.deepEqual(await db.terminalProposalReviewMessages(), [{ id: "proposal", channel_id: "channel", review_message_id: "message" }]);
	assert.match(queries[0].sql, /status IN \('pending_review','creating'\)/);
	assert.match(queries[1].sql, /review_message_id=\$2/);
	assert.match(queries[2].sql, /status IN \('created','dismissed','duplicate','failed','superseded','needs_reconciliation'\)/);
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
