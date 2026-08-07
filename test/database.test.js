import assert from "node:assert/strict";
import test from "node:test";
import { Database, embeddingVectorTypeMatches } from "../dist/database.js";

function databaseWithPool(pool) {
	if (!pool.connect) pool.connect = async () => ({ ...pool, release() {} });
	const db = Object.create(Database.prototype);
	Object.defineProperty(db, "pool", { value: pool });
	return db;
}

test("embedding vector dimensions must match the configured column type", () => {
	assert.equal(embeddingVectorTypeMatches("vector(1536)", 1536), true);
	assert.equal(embeddingVectorTypeMatches("vector(1024)", 1536), false);
	assert.equal(embeddingVectorTypeMatches(undefined, 1536), false);
});

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

test("reconciliation loads pending proposal images before finalizing", async () => {
	let query;
	const attachments = [{ id: "image", name: "banner.png", contentType: "image/png", url: "https://cdn.discordapp.com/banner.png" }];
	const db = databaseWithPool({ async query(sql, values) {
		query = { sql, values };
		return { rowCount: 1, rows: [{ attachments }] };
	} });
	assert.deepEqual(await db.reconciliationAttachments("proposal"), attachments);
	assert.match(query.sql, /source_attachments AS attachments/);
	assert.match(query.sql, /payload->'sourceAttachments'/);
	assert.deepEqual(query.values, ["proposal"]);
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
		sourceMessageIds: ["message"], sourceAttachments: [{ id: "image", name: "mockup.png", contentType: "image/png", url: "https://cdn.discordapp.com/image" }],
		classification: "direct_assignment", modelDeployment: "model",
	});
	assert.match(inserted.sql, /priority_id, size_href, start_date, due_date, estimated_hours/);
	assert.match(inserted.sql, /source_attachments/);
	assert.match(inserted.sql, /\$19,'pending_review',\$20/);
	assert.deepEqual(inserted.values.slice(7, 13), ["accountable", 4, "/api/v3/custom_options/5", "2026-07-14", "2026-07-21", 6]);
	assert.equal(inserted.values[13], '{"priority":false,"size":true,"estimate":true}');
	assert.match(inserted.values[15], /channel:3:message:create:new:user:prepare outreach/);
	assert.equal(inserted.values[17], '[{"id":"image","name":"mockup.png","contentType":"image/png","url":"https://cdn.discordapp.com/image"}]');
});

test("new proposals persist the RAG candidate allowlist transactionally", async () => {
	const queries = [];
	const db = databaseWithPool({
		async query(sql, values) {
			queries.push({ sql, values });
			return sql.includes("INSERT INTO task_proposals") ? { rowCount: 1, rows: [{ id: "proposal" }] } : { rowCount: 0, rows: [] };
		},
	});
	const candidates = [{
		workPackageId: 42, projectId: 7, lockVersion: 3, subject: "Sponsor prospectus",
		retrievalRank: 0, relationship: "same_work", confidence: 0.93, similarity: 0.72,
	}];
	await db.createProposal({
		channelId: "channel", projectId: 7, title: "Publish prospectus", description: "Publish it",
		sourceMessageIds: ["message"], modelDeployment: "model", ragCandidates: candidates,
	});
	const update = queries.find(query => query.sql.includes("SET rag_candidates"));
	assert.deepEqual(update.values, ["proposal", JSON.stringify(candidates)]);
	assert.equal(queries.findIndex(query => query.sql.includes("SET rag_candidates")) < queries.findIndex(query => query.sql === "COMMIT"), true);
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
	assert.deepEqual(insert.values.slice(29, 33), [1, '{"dueDate":"2026-07-31"}', "postComment", "- Change wording"]);
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

test("unauthorized pending proposals are excluded from automatic deduplication", async () => {
	const db = databaseWithPool({
		async query(sql) {
			if (sql.includes("SELECT id,title,status,work_item_key")) return {
				rowCount: 1, rows: [{ id: "restricted", title: "Publish venue map", description: "Old", status: "pending_review", work_item_key: "venue-map", source_content_hash: "old", revision: 1 }],
			};
			if (sql.includes("INSERT INTO task_proposals")) return { rowCount: 1, rows: [{ id: "new-proposal" }] };
			if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) return { rowCount: 0, rows: [] };
			throw new Error(`Unexpected query: ${sql}`);
		},
	});
	const proposal = await db.createProposal({
		channelId: "channel", title: "Publish venue map", description: "New", sourceMessageIds: ["new-message"],
		workItemKey: "venue-map", sourceContentHash: "new", modelDeployment: "model", permittedExistingProposalIds: [],
	});
	assert.equal(proposal.id, "new-proposal");
	assert.equal(proposal.reused, false);
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
	assert.match(revision.sql, /task_proposals\.permitted_reviewer_ids \|\| \$21::text\[\]/);
	assert.match(revision.sql, /task_proposals\.source_attachments \|\| \$32::jsonb/);
	assert.match(revision.sql, /content_operation=\$30/);
	assert.deepEqual(revision.values.slice(9, 16), [8, "new-owner", "accountable", null, null, null, "2026-08-01"]);
	assert.deepEqual(revision.values.slice(24, 31), ["update", 42, 5, 1, '{"dueDate":"2026-08-01"}', "postComment", "Clarified fields"]);
	assert.equal(queries.some(({ sql }) => sql.includes("'edit'")), true);
});

test("model reconciliation revises same-content proposals when operations change", async () => {
	const queries = [];
	const db = databaseWithPool({
		async query(sql, values) {
			queries.push({ sql, values });
			if (sql.includes("SELECT id,title,status,work_item_key")) return {
				rowCount: 1,
				rows: [{ id: "selected", title: "Sponsor deck", description: "Old scope", status: "pending_review", work_item_key: null, source_content_hash: "same-source", revision: 1 }],
			};
			if (sql.includes("UPDATE task_proposals SET title=")) return { rowCount: 1, rows: [{ revision: 2 }] };
			if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("pg_advisory_xact_lock")) return { rowCount: 0, rows: [] };
			throw new Error(`Unexpected query: ${sql}`);
		},
	});
	assert.deepEqual(await db.createProposal({
		preferredProposalId: "selected", channelId: "channel", title: "Sponsor deck", description: "Old scope",
		sourceMessageIds: ["message"], sourceContentHash: "same-source", modelDeployment: "model",
		action: "update", targetWorkPackageId: 42, targetLockVersion: 3,
		contentOperation: "postComment", contentMarkdown: "Updated operation",
	}), { id: "selected", reused: true, revised: true });
	const selection = queries.find(({ sql }) => sql.includes("SELECT id,title,status,work_item_key"));
	assert.match(selection.sql, /channel_id=\$1 AND .*id=\$8::uuid/s);
	assert.equal(selection.values[7], "selected");
	const revision = queries.find(({ sql }) => sql.includes("UPDATE task_proposals SET title="));
	assert.deepEqual(revision.values.slice(24, 31), ["update", 42, 3, 1, "{}", "postComment", "Updated operation"]);
});

test("superseded proposal lineage is merged into the survivor", async () => {
	let query;
	const db = databaseWithPool({
		async query(sql, values) {
			query = { sql, values };
			return { rowCount: 1, rows: [] };
		},
	});
	await db.mergePendingProposalLineage("00000000-0000-0000-0000-000000000001", [
		"00000000-0000-0000-0000-000000000001",
		"00000000-0000-0000-0000-000000000002",
	]);
	assert.match(query.sql, /target\.source_message_ids \|\| merged\.source_message_ids/);
	assert.match(query.sql, /target\.permitted_reviewer_ids \|\| merged\.permitted_reviewer_ids/);
	assert.match(query.sql, /merged\.source_attachments \|\| target\.source_attachments/);
	assert.deepEqual(query.values[1], ["00000000-0000-0000-0000-000000000002"]);
});

test("lineage merge and supersession lock and commit as one transaction", async () => {
	const queries = [];
	const db = databaseWithPool({
		async query(sql, values) {
			queries.push({ sql, values });
			if (sql.includes("SELECT id,status")) return { rowCount: 2, rows: [
				{ id: "00000000-0000-0000-0000-000000000001", status: "pending_review" },
				{ id: "00000000-0000-0000-0000-000000000002", status: "pending_review" },
			] };
			if (sql.includes("RETURNING id,channel_id,review_message_id")) return { rowCount: 1, rows: [{ id: "00000000-0000-0000-0000-000000000002", channel_id: "channel", review_message_id: "card" }] };
			return { rowCount: 1, rows: [] };
		},
	});
	const result = await db.mergeAndSupersedePendingProposals(
		"00000000-0000-0000-0000-000000000001",
		["00000000-0000-0000-0000-000000000002"],
	);
	assert.equal(result.length, 1);
	assert.equal(queries[0].sql, "BEGIN");
	assert.match(queries[1].sql, /FOR UPDATE/);
	assert.match(queries[2].sql, /UPDATE task_proposals target SET/);
	assert.match(queries[3].sql, /status='superseded'/);
	assert.equal(queries[4].sql, "COMMIT");
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

test("unresolved existing-task proposals persist with nullable target operations", async () => {
	const queries = [];
	const db = databaseWithPool({ async query(sql, values) {
		queries.push({ sql, values });
		return sql.includes("INSERT INTO task_proposals") ? { rowCount: 1, rows: [{ id: "proposal" }] } : { rowCount: 0, rows: [] };
	} });
	await db.createProposal({
		channelId: "channel", projectId: 3, title: "Update wording", description: "Add revisions",
		sourceMessageIds: ["message"], modelDeployment: "model", action: "update",
		contentOperation: "postComment", contentMarkdown: "- Change wording",
	});
	const insert = queries.find(query => query.sql.includes("INSERT INTO task_proposals"));
	assert.equal(insert.values[23], null);
	assert.equal(insert.values[24], null);
	assert.equal(insert.values[29], null);
	await assert.rejects(db.createProposal({
		channelId: "channel", title: "Bad target", description: "Bad", sourceMessageIds: ["other"], modelDeployment: "model",
		action: "update", targetWorkPackageId: 42,
	}), /targets require a lock version/);
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
	assert.match(updated.sql, /CASE WHEN action='create' THEN 'update'/);
	assert.deepEqual(updated.values, ["proposal", "create", 7, 42, 3, "{}", "postComment", "## Update\n\n- Revise it.", null]);
});

test("target resolution CASes action, prior target, project, lock, and operations together", async () => {
	let updated;
	const db = databaseWithPool({ async query(sql, values) { updated = { sql, values }; return { rowCount: 1, rows: [] }; } });
	await db.resolveProposalTarget({
		id: "proposal", expectedAction: "complete", expectedTargetWorkPackageId: undefined,
		projectId: 9, targetWorkPackageId: 42, targetLockVersion: 5,
		metadataPatch: { status: "complete" }, contentOperation: "none", contentMarkdown: null,
	});
	assert.match(updated.sql, /action=\$2/);
	assert.match(updated.sql, /target_work_package_id IS NOT DISTINCT FROM \$9/);
	assert.deepEqual(updated.values, ["proposal", "complete", 9, 42, 5, '{"status":"complete"}', "none", null, null]);
});

test("proposal claims require resolved operations for existing-task actions", async () => {
	let query;
	const db = databaseWithPool({ async query(sql, values) { query = { sql, values }; return { rowCount: 0, rows: [] }; } });
	assert.equal(await db.claimProposal("proposal", "reviewer"), false);
	assert.match(query.sql, /action='create' OR \(target_work_package_id IS NOT NULL/);
});

test("create-proposal detail edits commit inference, correction flags, and revision atomically", async () => {
	const queries = [];
	const db = databaseWithPool({ async query(sql, values) {
		queries.push({ sql, values });
		if (sql.includes("RETURNING *")) return { rowCount: 1, rows: [{
			revision: 2, title: "Task", description: "Details", project_id: 7,
			assignee_discord_id: null, accountable_discord_id: "owner", priority_id: 2,
			size_href: "/api/v3/custom_options/3", start_date: "2026-08-10", due_date: null,
			estimated_hours: 4, action: "create", target_work_package_id: null,
			source_message_ids: ["message"], source_links: [],
		}] };
		return { rowCount: 1, rows: [] };
	} });
	await db.updateProposalMetadata("proposal", "reviewer", {
		accountableId: "owner", priorityId: 2, sizeHref: "/api/v3/custom_options/3", startDate: "2026-08-10", estimatedHours: 4,
	});
	assert.equal(queries[0].sql, "BEGIN");
	assert.match(queries[1].sql, /metadata_inference=metadata_inference \|\|/);
	assert.match(queries[1].sql, /correction_flags=correction_flags \|\|/);
	assert.match(queries[2].sql, /task_proposal_revisions/);
	assert.equal(queries[3].sql, "COMMIT");
});

test("deleted cited sources supersede only pending proposals transactionally", async () => {
	const queries = [];
	const db = databaseWithPool({ async query(sql, values) {
		queries.push({ sql, values });
		if (sql.includes("RETURNING id,channel_id")) return { rowCount: 1, rows: [{ id: "proposal", channel_id: "channel", review_message_id: "card" }] };
		return { rowCount: 1, rows: [] };
	} });
	const rows = await db.supersedePendingProposalsForDeletedSource("message");
	assert.equal(rows.length, 1);
	assert.match(queries[1].sql, /WHERE status='pending_review'/);
	assert.match(queries[2].sql, /source_deleted/);
	assert.equal(queries.at(-1).sql, "COMMIT");
});

test("existing proposals retarget only before any operation is applied", async () => {
	let updated;
	const db = databaseWithPool({
		async query(sql, values) {
			updated = { sql, values };
			return { rowCount: 1, rows: [] };
		},
	});
	await db.retargetProposal({
		id: "proposal", expectedTargetWorkPackageId: 41, projectId: 7,
		targetWorkPackageId: 42, targetLockVersion: 3,
		metadataPatch: { dueDate: "2026-08-01" }, contentOperation: "postComment", contentMarkdown: "Update",
	});
	assert.match(updated.sql, /target_work_package_id=\$2/);
	assert.match(updated.sql, /patch_applied_at IS NULL/);
	assert.match(updated.sql, /comment_activity_id IS NULL/);
	assert.deepEqual(updated.values, ["proposal", 41, 42, 3, '{"dueDate":"2026-08-01"}', "postComment", "Update", 7]);
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
	assert.match(queries[3].sql, /rag_target_selected/);
	assert.match(queries[3].sql, /implicitApproval/);
	assert.match(queries[3].sql, /NOT EXISTS/);
	assert.deepEqual(queries[3].values, ["proposal", "reviewer", 42]);
	assert.match(queries[4].sql, /task_proposal_revisions/);
	assert.equal(queries[5].sql, "COMMIT");
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

test("proposal metrics aggregate RAG model and reviewer outcomes", async () => {
	const db = databaseWithPool({
		async query(sql) {
			if (sql.includes("WITH evaluations AS")) return { rows: [{
				evaluations: "20", recommendations: "8", abstentions: "10", failures: "2", average_latency_ms: "325.5",
				review_abstentions: "6", no_commonality: "3", no_candidates: "1", errors: "1", reranker_unavailable: "1",
			}] };
			if (sql.includes("WITH decisions AS")) return { rows: [{
				no_task: "3", incorrect: "2", reextracted: "1", reextracted_approved: "1",
			}] };
			if (sql.includes("event='rag_target_selected'")) return { rows: [{
				selections: "5", accepted_recommendations: "3", mean_reciprocal_rank: "0.7", recall_at_3: "0.8",
				reviewed_candidates: "6", keep_new_decisions: "2",
			}] };
			if (sql.includes("FROM ai_extraction_events")) return { rows: [{ average_latency_ms: "950", total_tokens: "4200", invalid_outputs: "1" }] };
			if (sql.includes("FROM task_proposals")) return { rows: [{
				proposals: "10", approved: "7", dismissed: "1", duplicates: "1", failures: "1", reconciliations: "0",
				review_failures: "0", average_review_duration_ms: "12000", correction_flags: {},
			}] };
			throw new Error(`Unexpected query: ${sql}`);
		},
	});
	const metrics = await db.proposalMetrics(30);
	assert.equal(metrics.ragRecommendationRate, 8 / 18);
	assert.equal(metrics.ragAbstentionRate, 10 / 18);
	assert.equal(metrics.ragFailureRate, 0.1);
	assert.equal(metrics.ragReviewAbstentions, 6);
	assert.equal(metrics.ragNoCommonality, 3);
	assert.equal(metrics.ragNoCandidates, 1);
	assert.equal(metrics.ragErrors, 1);
	assert.equal(metrics.ragRerankerUnavailable, 1);
	assert.equal(metrics.ragRecommendationAcceptanceRate, 0.6);
	assert.equal(metrics.ragMeanReciprocalRank, 0.7);
	assert.equal(metrics.ragRecallAt3, 0.8);
	assert.equal(metrics.ragKeepNewRate, 1 / 3);
	assert.equal(metrics.noTaskDismissals, 3);
	assert.equal(metrics.incorrectProposals, 2);
	assert.equal(metrics.incorrectReextractions, 1);
	assert.equal(metrics.incorrectReextractionApprovalRate, 1);
});

test("dismissed proposals require and persist a structured reason", async () => {
	let query;
	const db = databaseWithPool({ async query(sql, values) { query = { sql, values }; return { rowCount: 1, rows: [] }; } });
	await assert.rejects(db.setProposalStatus("proposal", "dismissed", "reviewer"), /dismissal reason is required/);
	assert.equal(await db.setProposalStatus("proposal", "dismissed", "reviewer", "question_or_announcement"), true);
	assert.match(query.sql, /dismissal_reason=\$4/);
	assert.deepEqual(query.values, ["proposal", "dismissed", "reviewer", "question_or_announcement"]);
});

test("direct proposal dismissals atomically preserve immutable review telemetry", async () => {
	const queries = [];
	const client = {
		async query(sql, values) {
			queries.push({ sql, values });
			if (sql.includes("UPDATE task_proposals")) return { rowCount: 1, rows: [{ id: "proposal" }] };
			return { rowCount: null, rows: [] };
		},
		release() {},
	};
	const db = databaseWithPool({ async connect() { return client; } });
	assert.equal(await db.dismissProposal("proposal", "reviewer", "incorrect_proposal"), true);
	assert.equal(queries[0].sql, "BEGIN");
	assert.match(queries[1].sql, /dismissal_reason=\$3/);
	assert.deepEqual(queries[1].values, ["proposal", "reviewer", "incorrect_proposal"]);
	assert.match(queries[2].sql, /'proposal_dismissed'/);
	assert.deepEqual(queries[2].values, ["proposal", "reviewer", { reason: "incorrect_proposal" }]);
	assert.equal(queries[3].sql, "COMMIT");
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
	assert.equal(await db.replaceProposalReviewMessage("proposal", "message", "replacement"), true);
	assert.equal(await db.clearProposalReviewMessage("proposal", "message"), true);
	assert.deepEqual(await db.terminalProposalReviewMessages(), [{ id: "proposal", channel_id: "channel", review_message_id: "message" }]);
	assert.match(queries[0].sql, /status IN \('pending_review','creating'\)/);
	assert.match(queries[1].sql, /review_message_id=\$3/);
	assert.deepEqual(queries[1].values, ["proposal", "message", "replacement"]);
	assert.match(queries[2].sql, /review_message_id=\$2/);
	assert.match(queries[3].sql, /status IN \('created','dismissed','duplicate','failed','superseded','needs_reconciliation'\)/);
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
