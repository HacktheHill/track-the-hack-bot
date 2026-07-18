import pg from "pg";
import type { IntegrationConfig } from "./config.js";
import { randomUUID } from "node:crypto";
import { proposalMetadataPatchSchema, type ContentOperation, type ProposalMetadataPatch } from "./task-proposals.js";

const { Pool } = pg;

function jsonParameter(value: unknown) {
	return value == null ? null : JSON.stringify(value);
}

export const correctionFields = [
	"title", "description", "project", "assignee", "accountable",
	"priority", "size", "startDate", "dueDate", "estimate",
] as const;
export type CorrectionField = typeof correctionFields[number];
export type CorrectionFlags = Record<CorrectionField, boolean>;

export type ProposalMetrics = {
	days: number;
	proposals: number;
	approved: number;
	dismissed: number;
	duplicates: number;
	failures: number;
	reconciliations: number;
	approvalRate: number;
	duplicateRate: number;
	assigneeAcceptanceRate: number;
	deadlineAcceptanceRate: number;
	averageReviewDurationMs: number;
	averageExtractionLatencyMs: number;
	totalTokens: number;
	invalidOutputs: number;
	correctionRates: Record<CorrectionField, number>;
};

export type SimilarWorkPackage = {
	workPackageId: number;
	projectId: number;
	lockVersion: number;
	subject: string;
	description: string;
	similarity: number;
};

export type ScheduledMessage = {
	id: string;
	guildId: string;
	channelId: string;
	createdByDiscordId: string;
	schedulerName: string;
	schedulerAvatarUrl: string | null;
	content: string;
	sendAt: string;
	status: string;
	attempts: number;
	error: string | null;
};

export class Database {
	readonly pool: pg.Pool;

	constructor(url: string) {
		this.pool = new Pool({ connectionString: url, max: 5 });
	}

	async migrate(config: IntegrationConfig) {
		await this.pool.query("SELECT pg_advisory_lock(hashtext('track-the-hack-bot-schema'))");
		try {
		await this.pool.query(`
			CREATE TABLE IF NOT EXISTS discord_openproject_users (
				discord_user_id TEXT PRIMARY KEY,
				openproject_user_id INTEGER NOT NULL,
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			CREATE TABLE IF NOT EXISTS task_proposals (
				id UUID PRIMARY KEY,
				requester_discord_id TEXT,
				channel_id TEXT NOT NULL,
				project_id INTEGER,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				assignee_discord_id TEXT,
				accountable_discord_id TEXT,
				priority_id INTEGER,
				size_href TEXT,
				start_date DATE,
				due_date DATE,
				estimated_hours NUMERIC,
				source_message_ids TEXT[] NOT NULL DEFAULT '{}',
				source_links TEXT[] NOT NULL DEFAULT '{}',
				source_fingerprint TEXT UNIQUE,
				classification TEXT,
				status TEXT NOT NULL DEFAULT 'draft',
				openproject_work_package_id INTEGER UNIQUE,
				reviewer_discord_id TEXT,
				model_deployment TEXT,
				permitted_reviewer_ids TEXT[] NOT NULL DEFAULT '{}',
				validation_result JSONB,
				evidence TEXT,
				ambiguities TEXT[] NOT NULL DEFAULT '{}',
				latency_ms INTEGER,
				token_usage JSONB,
				escalation_reason TEXT,
				confirmation_message_id TEXT,
				error TEXT,
				review_started_at TIMESTAMPTZ,
				reviewed_at TIMESTAMPTZ,
				review_duration_ms INTEGER,
				review_outcome TEXT,
				correction_flags JSONB NOT NULL DEFAULT '{}',
				review_failure_count INTEGER NOT NULL DEFAULT 0,
				operation_schema_version INTEGER,
				metadata_patch JSONB NOT NULL DEFAULT '{}',
				content_operation TEXT,
				content_markdown TEXT,
				patch_applied_at TIMESTAMPTZ,
				applied_lock_version INTEGER,
				comment_activity_id INTEGER,
				claim_expires_at TIMESTAMPTZ,
				expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			CREATE INDEX IF NOT EXISTS task_proposals_status_idx ON task_proposals(status);
			CREATE TABLE IF NOT EXISTS task_audit_log (
				id BIGSERIAL PRIMARY KEY,
				proposal_id UUID REFERENCES task_proposals(id) ON DELETE SET NULL,
				event TEXT NOT NULL,
				actor_discord_id TEXT,
				metadata JSONB NOT NULL DEFAULT '{}',
				created_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			CREATE TABLE IF NOT EXISTS discord_category_projects (
				category_id TEXT PRIMARY KEY,
				openproject_project_id INTEGER NOT NULL,
				updated_by_discord_id TEXT NOT NULL,
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			CREATE TABLE IF NOT EXISTS task_drafts (
				id UUID PRIMARY KEY,
				kind TEXT NOT NULL,
				user_id TEXT NOT NULL,
				channel_id TEXT NOT NULL,
				payload JSONB NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				openproject_work_package_id INTEGER,
				claimed_by TEXT,
				error TEXT,
				expires_at TIMESTAMPTZ NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			CREATE INDEX IF NOT EXISTS task_drafts_lookup_idx ON task_drafts(user_id, kind, status, expires_at);
			CREATE TABLE IF NOT EXISTS ai_extraction_events (
				id BIGSERIAL PRIMARY KEY,
				source TEXT NOT NULL,
				outcome TEXT NOT NULL,
				model_deployment TEXT,
				task_count INTEGER NOT NULL DEFAULT 0,
				latency_ms INTEGER,
				token_usage JSONB,
				trigger_id TEXT,
				input_snapshot JSONB,
				message_assessments JSONB,
				decision JSONB,
				schema_version TEXT NOT NULL DEFAULT 'v2',
				created_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			CREATE INDEX IF NOT EXISTS ai_extraction_events_created_idx ON ai_extraction_events(created_at)
		;
			CREATE TABLE IF NOT EXISTS task_proposal_revisions (
				id BIGSERIAL PRIMARY KEY,
				proposal_id UUID NOT NULL REFERENCES task_proposals(id) ON DELETE CASCADE,
				revision INTEGER NOT NULL,
				phase TEXT NOT NULL,
				payload JSONB NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				UNIQUE(proposal_id, revision)
			);
			CREATE TABLE IF NOT EXISTS task_confirmation_queue (
				work_package_id INTEGER PRIMARY KEY,
				channel_id TEXT NOT NULL,
				assignee_discord_id TEXT,
				attempts INTEGER NOT NULL DEFAULT 0,
				last_error TEXT,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			CREATE TABLE IF NOT EXISTS scheduled_messages (
				id UUID PRIMARY KEY,
				guild_id TEXT NOT NULL,
				channel_id TEXT NOT NULL,
				created_by_discord_id TEXT NOT NULL,
				scheduler_name TEXT NOT NULL,
				scheduler_avatar_url TEXT,
				content TEXT NOT NULL,
				send_at TIMESTAMPTZ NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				attempts INTEGER NOT NULL DEFAULT 0,
				next_attempt_at TIMESTAMPTZ,
				discord_message_id TEXT,
				error TEXT,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			CREATE INDEX IF NOT EXISTS scheduled_messages_due_idx
				ON scheduled_messages(status, send_at, next_attempt_at)
		`);
		await this.pool.query("DROP TABLE IF EXISTS discord_channel_projects");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS permitted_reviewer_ids TEXT[] NOT NULL DEFAULT '{}'");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS source_links TEXT[] NOT NULL DEFAULT '{}'");
		await this.pool.query("ALTER TABLE task_audit_log ADD COLUMN IF NOT EXISTS openproject_work_package_id INTEGER");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS evidence TEXT");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS ambiguities TEXT[] NOT NULL DEFAULT '{}'");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS latency_ms INTEGER");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS token_usage JSONB");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS escalation_reason TEXT");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS confirmation_message_id TEXT");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS error TEXT");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days')");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS priority_id INTEGER");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS size_href TEXT");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS start_date DATE");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS estimated_hours NUMERIC");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS review_started_at TIMESTAMPTZ");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS review_duration_ms INTEGER");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS review_outcome TEXT");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS correction_flags JSONB NOT NULL DEFAULT '{}'");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS review_failure_count INTEGER NOT NULL DEFAULT 0");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT 'create'");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS target_work_package_id INTEGER");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS target_lock_version INTEGER");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS operation_schema_version INTEGER");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS metadata_patch JSONB NOT NULL DEFAULT '{}'");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS content_operation TEXT");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS content_markdown TEXT");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS patch_applied_at TIMESTAMPTZ");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS applied_lock_version INTEGER");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS comment_activity_id INTEGER");
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ");
		await this.pool.query(`UPDATE task_proposals SET status='superseded', review_outcome='superseded',
			error='This proposal predates safe update operations. Extract the discussion again.', reviewed_at=now(), updated_at=now()
			WHERE status='pending_review' AND action <> 'create' AND operation_schema_version IS NULL`);
		await this.pool.query("ALTER TABLE task_proposals DROP CONSTRAINT IF EXISTS task_proposals_openproject_work_package_id_key");
		await this.pool.query("ALTER TABLE ai_extraction_events ADD COLUMN IF NOT EXISTS trigger_id TEXT");
		await this.pool.query("ALTER TABLE ai_extraction_events ADD COLUMN IF NOT EXISTS input_snapshot JSONB");
		await this.pool.query("ALTER TABLE ai_extraction_events ADD COLUMN IF NOT EXISTS message_assessments JSONB");
		await this.pool.query("ALTER TABLE ai_extraction_events ADD COLUMN IF NOT EXISTS decision JSONB");
		await this.pool.query("ALTER TABLE ai_extraction_events ADD COLUMN IF NOT EXISTS schema_version TEXT NOT NULL DEFAULT 'v2'");
		if (config.OPENPROJECT_RAG_MODE !== "off") {
			if (!config.AZURE_OPENAI_EMBEDDING_DIMENSIONS) throw new Error("AZURE_OPENAI_EMBEDDING_DIMENSIONS is required when OPENPROJECT_RAG_MODE is enabled.");
			await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");
			await this.pool.query(`CREATE TABLE IF NOT EXISTS openproject_embeddings (
				work_package_id INTEGER PRIMARY KEY,
				project_id INTEGER NOT NULL,
				lock_version INTEGER NOT NULL,
				subject TEXT NOT NULL,
				description TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				embedding_model TEXT NOT NULL,
				embedding_dimensions INTEGER NOT NULL,
				embedding vector(${config.AZURE_OPENAI_EMBEDDING_DIMENSIONS}),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)`);
			await this.pool.query("CREATE INDEX IF NOT EXISTS openproject_embeddings_project_idx ON openproject_embeddings(project_id)");
			await this.pool.query("CREATE TABLE IF NOT EXISTS openproject_embedding_sync (id BOOLEAN PRIMARY KEY DEFAULT TRUE, last_run_at TIMESTAMPTZ, last_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
		}
		for (const [discordId, openProjectId] of Object.entries(config.userMap)) {
			await this.pool.query(
				`INSERT INTO discord_openproject_users(discord_user_id, openproject_user_id)
				 VALUES ($1,$2) ON CONFLICT(discord_user_id) DO UPDATE
				 SET openproject_user_id=excluded.openproject_user_id, updated_at=now()`,
				[discordId, openProjectId],
			);
		}
		for (const [categoryId, projectId] of Object.entries(config.categoryProjects)) {
			await this.pool.query(
				`INSERT INTO discord_category_projects(category_id,openproject_project_id,updated_by_discord_id)
				 VALUES($1,$2,'environment') ON CONFLICT(category_id) DO UPDATE SET
				 openproject_project_id=excluded.openproject_project_id, updated_at=now()`,
				[categoryId, projectId],
			);
		}
		} finally {
			await this.pool.query("SELECT pg_advisory_unlock(hashtext('track-the-hack-bot-schema'))");
		}
	}

	async openProjectUserId(discordId: string) {
		const result = await this.pool.query<{ openproject_user_id: number }>(
			"SELECT openproject_user_id FROM discord_openproject_users WHERE discord_user_id=$1",
			[discordId],
		);
		return result.rows[0]?.openproject_user_id;
	}

	async openProjectUserMappings() {
		const result = await this.pool.query<{ discord_user_id: string; openproject_user_id: number }>(
			"SELECT discord_user_id, openproject_user_id FROM discord_openproject_users",
		);
		return new Map(result.rows.map(row => [row.discord_user_id, row.openproject_user_id]));
	}

	async setOpenProjectUser(discordId: string, openProjectId: number) {
		await this.pool.query(
			`INSERT INTO discord_openproject_users(discord_user_id, openproject_user_id)
			 VALUES ($1,$2) ON CONFLICT(discord_user_id) DO UPDATE
			 SET openproject_user_id=excluded.openproject_user_id, updated_at=now()`,
			[discordId, openProjectId],
		);
	}

	async createScheduledMessage(input: {
		guildId: string;
		channelId: string;
		createdByDiscordId: string;
		schedulerName: string;
		schedulerAvatarUrl?: string;
		content: string;
		sendAt: Date;
	}) {
		const id = randomUUID();
		await this.pool.query(
			`INSERT INTO scheduled_messages
			 (id,guild_id,channel_id,created_by_discord_id,scheduler_name,scheduler_avatar_url,content,send_at)
			 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
			[id, input.guildId, input.channelId, input.createdByDiscordId, input.schedulerName,
				input.schedulerAvatarUrl ?? null, input.content, input.sendAt],
		);
		return id;
	}

	async scheduledMessagesForUser(guildId: string, userId: string, limit = 10) {
		const result = await this.pool.query<ScheduledMessage>(
			`SELECT id, guild_id AS "guildId", channel_id AS "channelId",
			 created_by_discord_id AS "createdByDiscordId", scheduler_name AS "schedulerName",
			 scheduler_avatar_url AS "schedulerAvatarUrl", content, send_at AS "sendAt",
			 status, attempts, error
			 FROM scheduled_messages
			 WHERE guild_id=$1 AND created_by_discord_id=$2 AND status='pending'
			 ORDER BY send_at ASC LIMIT $3`,
			[guildId, userId, limit],
		);
		return result.rows;
	}

	async cancelScheduledMessage(id: string, guildId: string, userId: string) {
		const result = await this.pool.query(
			`UPDATE scheduled_messages SET status='cancelled', updated_at=now()
			 WHERE id=$1 AND guild_id=$2 AND created_by_discord_id=$3 AND status='pending'`,
			[id, guildId, userId],
		);
		return result.rowCount === 1;
	}

	async claimDueScheduledMessages(limit = 10): Promise<ScheduledMessage[]> {
		const result = await this.pool.query<ScheduledMessage>(
			`WITH due AS (
				SELECT id FROM scheduled_messages
				WHERE (
					status='pending'
					AND send_at <= now()
					AND (next_attempt_at IS NULL OR next_attempt_at <= now())
				) OR (status='processing' AND updated_at < now() - interval '5 minutes')
				ORDER BY send_at ASC
				FOR UPDATE SKIP LOCKED
				LIMIT $1
			)
			UPDATE scheduled_messages AS message
			SET status='processing', attempts=attempts + 1, updated_at=now()
			FROM due WHERE message.id=due.id
			RETURNING message.id, message.guild_id AS "guildId", message.channel_id AS "channelId",
			 message.created_by_discord_id AS "createdByDiscordId", message.scheduler_name AS "schedulerName",
			 message.scheduler_avatar_url AS "schedulerAvatarUrl", message.content,
			 message.send_at AS "sendAt", message.status, message.attempts, message.error`,
			[limit],
		);
		return result.rows;
	}

	async markScheduledMessageSent(id: string, discordMessageId: string) {
		await this.pool.query(
			`UPDATE scheduled_messages SET status='sent', discord_message_id=$2,
			 error=NULL, next_attempt_at=NULL, updated_at=now()
			 WHERE id=$1 AND status='processing'`,
			[id, discordMessageId],
		);
	}

	async markScheduledMessageDeliveryFailed(id: string, error: string, retryAfterSeconds?: number) {
		await this.pool.query(
			`UPDATE scheduled_messages SET status=$2, error=$3,
			 next_attempt_at=CASE WHEN $4::integer IS NULL THEN NULL ELSE now() + ($4::text || ' seconds')::interval END,
			 updated_at=now() WHERE id=$1 AND status='processing'`,
			[id, retryAfterSeconds ? "pending" : "failed", error.slice(0, 1000), retryAfterSeconds ?? null],
		);
	}

	async categoryProject(categoryId: string) {
		const result = await this.pool.query<{ openproject_project_id: number }>(
			"SELECT openproject_project_id FROM discord_category_projects WHERE category_id=$1",
			[categoryId],
		);
		return result.rows[0]?.openproject_project_id;
	}

	async categoryProjectIds() {
		const result = await this.pool.query<{ openproject_project_id: number }>(
			"SELECT DISTINCT openproject_project_id FROM discord_category_projects",
		);
		return result.rows.map(row => row.openproject_project_id);
	}

	async setCategoryProject(categoryId: string, projectId: number, actorId: string) {
		await this.pool.query(
			`INSERT INTO discord_category_projects(category_id,openproject_project_id,updated_by_discord_id)
			 VALUES($1,$2,$3) ON CONFLICT(category_id) DO UPDATE SET
			 openproject_project_id=excluded.openproject_project_id,
			 updated_by_discord_id=excluded.updated_by_discord_id, updated_at=now()`,
			[categoryId, projectId, actorId],
		);
	}

	async createDraft<T>(kind: string, userId: string, channelId: string, payload: T, ttlMinutes = 15) {
		const id = randomUUID();
		await this.pool.query(
			`INSERT INTO task_drafts(id,kind,user_id,channel_id,payload,expires_at)
			 VALUES($1,$2,$3,$4,$5,now() + ($6::text || ' minutes')::interval)`,
			[id, kind, userId, channelId, payload, ttlMinutes],
		);
		return id;
	}

	async draft<T>(id: string, userId: string, kind: string) {
		const result = await this.pool.query<{ payload: T; expires_at: string; status: string; error: string | null }>(
			"SELECT payload, expires_at, status, error FROM task_drafts WHERE id=$1 AND user_id=$2 AND kind=$3",
			[id, userId, kind],
		);
		const row = result.rows[0];
		if (!row) throw new Error("This task draft no longer exists. Start the workflow again.");
		if (new Date(row.expires_at).getTime() <= Date.now()) {
			await this.pool.query("DELETE FROM task_drafts WHERE id=$1 AND status='pending'", [id]);
			throw new Error("This task draft expired. Start the workflow again.");
		}
		if (row.status === "creating") throw new Error("This task draft is currently being handled.");
		if (row.status === "created") throw new Error("This task has already been created.");
		if (row.status === "needs_reconciliation") throw new Error("This task may already exist in OpenProject and requires reconciliation.");
		if (row.status !== "pending") throw new Error(`The previous creation attempt failed${row.error ? `: ${row.error}` : "."} Start the workflow again.`);
		return row.payload;
	}

	async updateDraft<T>(id: string, userId: string, kind: string, payload: T) {
		const result = await this.pool.query(
			"UPDATE task_drafts SET payload=$4, updated_at=now() WHERE id=$1 AND user_id=$2 AND kind=$3 AND status='pending' AND expires_at > now()",
			[id, userId, kind, payload],
		);
		if (result.rowCount !== 1) throw new Error("This task draft expired or is already being handled.");
	}

	async claimDraft(id: string, userId: string, kind: string) {
		const result = await this.pool.query(
			`UPDATE task_drafts SET status='creating', claimed_by=$4, updated_at=now()
			 WHERE id=$1 AND user_id=$2 AND kind=$3 AND status='pending' AND expires_at > now()
			 RETURNING id`,
			[id, userId, kind, userId],
		);
		return result.rowCount === 1;
	}

	async completeDraft(id: string, workPackageId: number) {
		const result = await this.pool.query(
			"UPDATE task_drafts SET status='created', openproject_work_package_id=$2, updated_at=now() WHERE id=$1 AND status='creating'",
			[id, workPackageId],
		);
		if (result.rowCount !== 1) throw new Error("Could not persist the completed task draft.");
	}

	async releaseDraft(id: string, error: string, ttlMinutes: number) {
		await this.pool.query(
			`UPDATE task_drafts SET status='pending', claimed_by=NULL, error=$2,
			 expires_at=GREATEST(expires_at, now() + ($3::text || ' minutes')::interval), updated_at=now()
			 WHERE id=$1 AND status='creating'`,
			[id, error.slice(0, 1000), ttlMinutes],
		);
	}

	async failDraft(id: string, error: string, status: "failed" | "needs_reconciliation" = "failed") {
		await this.pool.query(
			"UPDATE task_drafts SET status=$2, error=$3, updated_at=now() WHERE id=$1 AND status='creating'",
			[id, status, error.slice(0, 1000)],
		);
	}

	async createProposal(input: {
		requesterId?: string;
		channelId: string;
		projectId?: number;
		title: string;
		description: string;
		assigneeDiscordId?: string;
		accountableDiscordId?: string;
		priorityId?: number;
		sizeHref?: string;
		startDate?: string;
		dueDate?: string;
		estimatedHours?: number;
		sourceMessageIds: string[];
		sourceLinks?: string[];
		classification: string;
		modelDeployment: string;
		permittedReviewerIds?: string[];
		evidence?: string;
		ambiguities?: string[];
		latencyMs?: number;
		tokenUsage?: Record<string, number | undefined>;
		escalationReason?: string;
			retentionDays?: number;
		action?: "create" | "update" | "complete" | "reopen";
		targetWorkPackageId?: number;
		targetLockVersion?: number;
		initialSnapshot?: Record<string, unknown>;
		metadataPatch?: ProposalMetadataPatch;
		contentOperation?: ContentOperation;
		contentMarkdown?: string | null;
	}) {
		const id = randomUUID();
		const fingerprint = [...input.sourceMessageIds].sort().join(":") + `:${input.action ?? "create"}:${input.targetWorkPackageId ?? "new"}:${input.title.toLowerCase()}`;
		const result = await this.pool.query<{ id: string }>(
			`INSERT INTO task_proposals
			(id, requester_discord_id, channel_id, project_id, title, description,
			 assignee_discord_id, accountable_discord_id, priority_id, size_href, start_date, due_date, estimated_hours,
			 source_message_ids, source_fingerprint, source_links,
			 classification, status, model_deployment, permitted_reviewer_ids, action, target_work_package_id, target_lock_version,
			 evidence, ambiguities, latency_ms, token_usage, escalation_reason,
			 operation_schema_version, metadata_patch, content_operation, content_markdown, expires_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'pending_review',$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
			 $28,$29,$30,$31,now() + ($32::text || ' days')::interval)
			ON CONFLICT(source_fingerprint) DO UPDATE SET
			 requester_discord_id=excluded.requester_discord_id, channel_id=excluded.channel_id,
			 project_id=excluded.project_id, title=excluded.title, description=excluded.description,
			 assignee_discord_id=excluded.assignee_discord_id, accountable_discord_id=excluded.accountable_discord_id,
			 priority_id=excluded.priority_id,
			 size_href=excluded.size_href, start_date=excluded.start_date, due_date=excluded.due_date,
			 estimated_hours=excluded.estimated_hours,
				 source_message_ids=excluded.source_message_ids, source_links=excluded.source_links, classification=excluded.classification,
				action=excluded.action, target_work_package_id=excluded.target_work_package_id, target_lock_version=excluded.target_lock_version,
			 status='pending_review', model_deployment=excluded.model_deployment,
			 permitted_reviewer_ids=excluded.permitted_reviewer_ids, evidence=excluded.evidence,
			 ambiguities=excluded.ambiguities, latency_ms=excluded.latency_ms,
				 token_usage=excluded.token_usage, escalation_reason=excluded.escalation_reason,
				 operation_schema_version=excluded.operation_schema_version, metadata_patch=excluded.metadata_patch,
				 content_operation=excluded.content_operation, content_markdown=excluded.content_markdown,
				 patch_applied_at=NULL, applied_lock_version=NULL, comment_activity_id=NULL,
				 reviewer_discord_id=NULL, openproject_work_package_id=NULL,
				 confirmation_message_id=NULL, error=NULL, expires_at=excluded.expires_at, updated_at=now()
			WHERE task_proposals.status IN ('dismissed','duplicate','failed','superseded')
			RETURNING id`,
			[id, input.requesterId, input.channelId, input.projectId ?? null, input.title,
			 input.description, input.assigneeDiscordId ?? null, input.accountableDiscordId ?? null,
			 input.priorityId ?? null, input.sizeHref ?? null,
			 input.startDate ?? null, input.dueDate ?? null, input.estimatedHours ?? null,
			 input.sourceMessageIds, fingerprint, input.sourceLinks ?? [], input.classification, input.modelDeployment,
			 input.permittedReviewerIds ?? (input.requesterId ? [input.requesterId] : []), input.action ?? "create", input.targetWorkPackageId ?? null, input.targetLockVersion ?? null,
			 input.evidence ?? null, input.ambiguities ?? [], input.latencyMs ?? null,
			 input.tokenUsage ?? null, input.escalationReason ?? null,
			 input.action && input.action !== "create" ? 1 : null, jsonParameter(input.metadataPatch ?? {}),
			 input.contentOperation ?? null, input.contentMarkdown ?? null, input.retentionDays ?? 30],
		);
		if (result.rows[0]) {
			if (input.initialSnapshot) await this.recordProposalRevision(result.rows[0].id, 1, "initial", input.initialSnapshot);
			return { id: result.rows[0].id, reused: false };
		}
		const existing = await this.pool.query<{ id: string }>(
			"SELECT id FROM task_proposals WHERE source_fingerprint=$1",
			[fingerprint],
		);
		if (!existing.rows[0]) throw new Error("Proposal idempotency conflict could not be reconciled.");
		return { id: existing.rows[0].id, reused: true };
	}

	async proposal(id: string) {
		const result = await this.pool.query<{
			id: string; requester_discord_id: string | null; channel_id: string;
			project_id: number | null; title: string; description: string;
			assignee_discord_id: string | null; accountable_discord_id: string | null;
			priority_id: number | null; size_href: string | null;
			start_date: string | null; due_date: string | null; estimated_hours: number | null;
			 source_message_ids: string[]; source_links: string[]; status: string; permitted_reviewer_ids: string[];
			 expires_at: string; openproject_work_package_id: number | null;
			 action: "create" | "update" | "complete" | "reopen"; target_work_package_id: number | null; target_lock_version: number | null;
			 operation_schema_version: number | null; metadata_patch: ProposalMetadataPatch;
			 content_operation: ContentOperation | null; content_markdown: string | null;
			 patch_applied_at: string | null; applied_lock_version: number | null; comment_activity_id: number | null;
			 claim_expires_at: string | null;
		}>("SELECT * FROM task_proposals WHERE id=$1", [id]);
		const row = result.rows[0];
		return row ? { ...row, metadata_patch: proposalMetadataPatchSchema.parse(row.metadata_patch ?? {}) } : undefined;
	}

	async setProposalStatus(id: string, status: string, reviewerId: string) {
		const result = await this.pool.query(
			`UPDATE task_proposals SET status=$2, reviewer_discord_id=$3,
			 review_outcome=$2, reviewed_at=now(),
			 review_duration_ms=GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(review_started_at, created_at))) * 1000)::integer,
			 updated_at=now() WHERE id=$1 AND status='pending_review' AND expires_at > now()`,
			[id, status, reviewerId],
		);
		return result.rowCount === 1;
	}

	async markProposalDeliveryFailed(id: string, error: string) {
		await this.pool.query(
			`UPDATE task_proposals SET status='failed', review_outcome='delivery_failed', error=$2,
			 reviewed_at=now(), updated_at=now() WHERE id=$1 AND status='pending_review'`,
			[id, error.slice(0, 1000)],
		);
	}

	async supersedeLegacyProposal(id: string) {
		await this.pool.query(
			`UPDATE task_proposals SET status='superseded', review_outcome='superseded',
			 error='This proposal predates safe update operations. Extract the discussion again.', reviewed_at=now(), updated_at=now()
			 WHERE id=$1 AND action <> 'create' AND operation_schema_version IS NULL AND status IN ('pending_review','creating')`,
			[id],
		);
	}

	async updateProposalMetadata(id: string, reviewerId: string, fields: {
		accountableId?: string | null; priorityId?: number | null; sizeHref?: string | null;
		startDate?: string | null; estimatedHours?: number | null;
	}) {
		const result = await this.pool.query<{
			revision: number; title: string; description: string; project_id: number | null;
			assignee_discord_id: string | null; accountable_discord_id: string | null;
			priority_id: number | null; size_href: string | null; start_date: string | null;
			due_date: string | null; estimated_hours: number | null; action: string;
			target_work_package_id: number | null; source_message_ids: string[]; source_links: string[];
		}>(
			`UPDATE task_proposals SET accountable_discord_id=$2, priority_id=$3, size_href=$4, start_date=$5,
			 estimated_hours=$6, revision=revision + 1, reviewer_discord_id=$7, updated_at=now()
			 WHERE id=$1 AND status='pending_review' AND expires_at > now() RETURNING *`,
			[id, fields.accountableId ?? null, fields.priorityId ?? null, fields.sizeHref ?? null, fields.startDate ?? null, fields.estimatedHours ?? null, reviewerId],
		);
		if (result.rowCount !== 1) throw new Error("This proposal is no longer editable.");
		const row = result.rows[0];
		await this.recordProposalRevision(id, row.revision, "edit", {
			title: row.title, description: row.description, projectId: row.project_id,
			assigneeId: row.assignee_discord_id, accountableId: row.accountable_discord_id,
			priorityId: row.priority_id, sizeHref: row.size_href, startDate: row.start_date,
			dueDate: row.due_date, estimatedHours: row.estimated_hours, action: row.action,
			targetWorkPackageId: row.target_work_package_id, sourceMessageIds: row.source_message_ids,
			sourceLinks: row.source_links,
		});
	}

	async claimProposal(id: string, reviewerId: string) {
		const result = await this.pool.query(
			`UPDATE task_proposals SET status='creating', reviewer_discord_id=$2,
			 review_started_at=COALESCE(review_started_at, now()),
			 claim_expires_at=now() + interval '15 minutes', updated_at=now()
			 WHERE id=$1 AND (status='pending_review' OR (status='creating' AND claim_expires_at < now()))
			 AND expires_at > now() RETURNING id`,
			[id, reviewerId],
		);
		return result.rowCount === 1;
	}

	async releaseProposal(id: string, error: string) {
		await this.pool.query(
			`UPDATE task_proposals SET status='pending_review', reviewer_discord_id=NULL, claim_expires_at=NULL,
			 error=$2, review_failure_count=review_failure_count + 1, updated_at=now()
			 WHERE id=$1 AND status='creating' AND expires_at > now()`,
			[id, error.slice(0, 1000)],
		);
	}

	async markProposalPatchApplied(id: string, lockVersion: number) {
		await this.pool.query(
			"UPDATE task_proposals SET patch_applied_at=now(), applied_lock_version=$2, updated_at=now() WHERE id=$1 AND status='creating'",
			[id, lockVersion],
		);
	}

	async markProposalCommentApplied(id: string, activityId: number) {
		await this.pool.query(
			"UPDATE task_proposals SET comment_activity_id=$2, updated_at=now() WHERE id=$1 AND status='creating'",
			[id, activityId],
		);
	}

	async markProposalCreated(id: string, reviewerId: string, workPackageId: number, confirmationMessageId?: string, corrections?: CorrectionFlags) {
		await this.pool.query(
			`UPDATE task_proposals SET status='created', reviewer_discord_id=$2,
				 openproject_work_package_id=$3, confirmation_message_id=$4, error=NULL,
				 review_outcome='approved', reviewed_at=now(), correction_flags=$5,
				 claim_expires_at=NULL,
				 review_duration_ms=GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(review_started_at, created_at))) * 1000)::integer,
				 updated_at=now() WHERE id=$1 AND status='creating'`,
			[id, reviewerId, workPackageId, confirmationMessageId ?? null, corrections ?? {}],
		);
		await this.pool.query(
			"INSERT INTO task_audit_log(proposal_id,event,actor_discord_id,metadata) VALUES($1,'created',$2,$3)",
			[id, reviewerId, { workPackageId }],
		);
	}

	async markProposalUpdated(id: string, reviewerId: string, workPackageId: number, corrections?: CorrectionFlags, action = "update") {
		await this.pool.query(
			`UPDATE task_proposals SET status='created', reviewer_discord_id=$2, openproject_work_package_id=$3,
			 review_outcome=$5, reviewed_at=now(), correction_flags=$4, claim_expires_at=NULL,
			 review_duration_ms=GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(review_started_at, created_at))) * 1000)::integer,
			 updated_at=now() WHERE id=$1 AND status='creating'`,
			[id, reviewerId, workPackageId, corrections ?? {}, action],
		);
		await this.pool.query(
			"INSERT INTO task_audit_log(proposal_id,event,actor_discord_id,metadata) VALUES($1,$2,$3,$4)",
			[id, action, reviewerId, { workPackageId }],
		);
	}

	async finalizeProposalUpdate(input: {
		id: string; reviewerId: string; workPackageId: number; corrections: CorrectionFlags;
		action: string; finalSnapshot: Record<string, unknown>;
	}) {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const result = await client.query<{ revision: number }>(
				`UPDATE task_proposals SET status='created', reviewer_discord_id=$2, openproject_work_package_id=$3,
				 review_outcome=$5, reviewed_at=now(), correction_flags=$4, claim_expires_at=NULL,
				 revision=revision + 1,
				 review_duration_ms=GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(review_started_at, created_at))) * 1000)::integer,
				 updated_at=now() WHERE id=$1 AND status='creating' RETURNING revision`,
				[input.id, input.reviewerId, input.workPackageId, input.corrections, input.action],
			);
			if (result.rowCount !== 1) throw new Error("This proposal is no longer being applied.");
			await client.query(
				"INSERT INTO task_audit_log(proposal_id,event,actor_discord_id,metadata) VALUES($1,$2,$3,$4)",
				[input.id, input.action, input.reviewerId, { workPackageId: input.workPackageId }],
			);
			await client.query(
				"INSERT INTO task_proposal_revisions(proposal_id,revision,phase,payload) VALUES($1,$2,'final',$3)",
				[input.id, result.rows[0].revision, jsonParameter(input.finalSnapshot)],
			);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async markProposalFailed(id: string, status: "failed" | "needs_reconciliation", reviewerId: string, error: string) {
		await this.pool.query(
			`UPDATE task_proposals SET status=$2, reviewer_discord_id=$3, error=$4,
			 review_outcome=$2, reviewed_at=now(), review_failure_count=review_failure_count + 1, claim_expires_at=NULL,
			 review_duration_ms=GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(review_started_at, created_at))) * 1000)::integer,
			 updated_at=now() WHERE id=$1 AND status='creating'`,
			[id, status, reviewerId, error.slice(0, 1000)],
		);
	}

	async reconcileCreation(id: string, actorId: string, workPackageId: number) {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const proposal = await client.query(
				`UPDATE task_proposals SET status='created', reviewer_discord_id=$2,
				 openproject_work_package_id=$3, error=NULL, updated_at=now()
				 WHERE id=$1 AND status='needs_reconciliation' RETURNING id`,
				[id, actorId, workPackageId],
			);
			if (proposal.rowCount === 1) {
				await client.query(
					"UPDATE task_proposals SET review_outcome='reconciled', reviewed_at=COALESCE(reviewed_at, now()) WHERE id=$1",
					[id],
				);
				await client.query(
					"INSERT INTO task_audit_log(proposal_id,event,actor_discord_id,metadata) VALUES($1,'reconciled',$2,$3)",
					[id, actorId, { workPackageId }],
				);
			} else {
				const draft = await client.query(
					`UPDATE task_drafts SET status='created', openproject_work_package_id=$2,
					 claimed_by=$3, error=NULL, updated_at=now()
					 WHERE id=$1 AND status='needs_reconciliation' RETURNING id`,
					[id, workPackageId, actorId],
				);
				if (draft.rowCount !== 1) throw new Error("That creation is not awaiting reconciliation.");
				await client.query(
					"INSERT INTO task_audit_log(openproject_work_package_id,event,actor_discord_id,metadata) VALUES($1,'reconciled',$2,$3)",
					[workPackageId, actorId, { draftId: id }],
				);
			}
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async recordExtraction(input: {
		source: "manual" | "automatic";
		outcome: "proposal" | "no_task" | "duplicate" | "invalid_output" | "sensitive_block" | "error";
		modelDeployment?: string;
		taskCount?: number;
		latencyMs?: number;
		tokenUsage?: Record<string, number | undefined>;
		triggerId?: string;
		inputSnapshot?: unknown;
		messageAssessments?: unknown;
		decision?: Record<string, unknown>;
	}) {
		await this.pool.query(
			`INSERT INTO ai_extraction_events(source,outcome,model_deployment,task_count,latency_ms,token_usage,trigger_id,input_snapshot,message_assessments,decision)
			 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			[input.source, input.outcome, input.modelDeployment ?? null, input.taskCount ?? 0,
				input.latencyMs ?? null, jsonParameter(input.tokenUsage), input.triggerId ?? null, jsonParameter(input.inputSnapshot),
				jsonParameter(input.messageAssessments), jsonParameter(input.decision)],
		);
	}

	async recordProposalRevision(proposalId: string, revision: number, phase: "initial" | "edit" | "final", payload: Record<string, unknown>) {
		await this.pool.query(
			`INSERT INTO task_proposal_revisions(proposal_id,revision,phase,payload) VALUES($1,$2,$3,$4)
			 ON CONFLICT(proposal_id,revision) DO UPDATE SET phase=excluded.phase,payload=excluded.payload,created_at=now()`,
			[proposalId, revision, phase, jsonParameter(payload)],
		);
	}

	async recordFinalProposalRevision(proposalId: string, payload: Record<string, unknown>) {
		const result = await this.pool.query<{ revision: number }>(
			"UPDATE task_proposals SET revision=revision + 1 WHERE id=$1 AND status='created' RETURNING revision",
			[proposalId],
		);
		if (result.rowCount !== 1) throw new Error("Could not finalize proposal revision telemetry.");
		await this.recordProposalRevision(proposalId, result.rows[0].revision, "final", payload);
	}

	async upsertEmbedding(input: {
		workPackageId: number; projectId: number; lockVersion: number; subject: string; description: string;
		contentHash: string; model: string; dimensions: number; embedding: number[];
	}) {
		const vector = `[${input.embedding.join(",")}]`;
		await this.pool.query(
			`INSERT INTO openproject_embeddings(work_package_id,project_id,lock_version,subject,description,content_hash,embedding_model,embedding_dimensions,embedding,updated_at,indexed_at)
			 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,now(),now())
			 ON CONFLICT(work_package_id) DO UPDATE SET project_id=excluded.project_id, lock_version=excluded.lock_version,
			 subject=excluded.subject, description=excluded.description, content_hash=excluded.content_hash,
			 embedding_model=excluded.embedding_model, embedding_dimensions=excluded.embedding_dimensions, embedding=excluded.embedding,
			 updated_at=now(), indexed_at=now()`,
			[input.workPackageId, input.projectId, input.lockVersion, input.subject, input.description, input.contentHash, input.model, input.dimensions, vector],
		);
	}

	async embeddingIsCurrent(workPackageId: number, contentHash: string, lockVersion: number) {
		const result = await this.pool.query(
			"SELECT 1 FROM openproject_embeddings WHERE work_package_id=$1 AND content_hash=$2 AND lock_version=$3",
			[workPackageId, contentHash, lockVersion],
		);
		return result.rowCount === 1;
	}

	async deleteEmbeddingsExcept(projectId: number, workPackageIds: number[]) {
		if (!workPackageIds.length) {
			await this.pool.query("DELETE FROM openproject_embeddings WHERE project_id=$1", [projectId]);
			return;
		}
		await this.pool.query(
			"DELETE FROM openproject_embeddings WHERE project_id=$1 AND NOT (work_package_id = ANY($2::integer[]))",
			[projectId, workPackageIds],
		);
	}

	async similarEmbeddings(projectId: number, embedding: number[], limit = 5): Promise<SimilarWorkPackage[]> {
		const vector = `[${embedding.join(",")}]`;
		const result = await this.pool.query<SimilarWorkPackage & { distance: number }>(
			`SELECT work_package_id AS "workPackageId", project_id AS "projectId", lock_version AS "lockVersion", subject, description,
				1 - (embedding <=> $2::vector) AS similarity, embedding <=> $2::vector AS distance
			 FROM openproject_embeddings WHERE project_id=$1 AND embedding IS NOT NULL ORDER BY embedding <=> $2::vector LIMIT $3`,
			[projectId, vector, limit],
		);
		return result.rows;
	}

	async embeddingTitles(projectId: number): Promise<Omit<SimilarWorkPackage, "similarity">[]> {
		const result = await this.pool.query<Omit<SimilarWorkPackage, "similarity">>(
			`SELECT work_package_id AS "workPackageId", project_id AS "projectId", lock_version AS "lockVersion", subject, description
			 FROM openproject_embeddings WHERE project_id=$1`,
			[projectId],
		);
		return result.rows;
	}

	async recordEmbeddingSync(error?: string) {
		await this.pool.query(
			`INSERT INTO openproject_embedding_sync(id,last_run_at,last_error,updated_at) VALUES(TRUE,now(),$1,now())
			 ON CONFLICT(id) DO UPDATE SET last_run_at=excluded.last_run_at,last_error=excluded.last_error,updated_at=now()`,
			[error?.slice(0, 1000) ?? null],
		);
	}

	async proposalMetrics(days: 7 | 30 | 90): Promise<ProposalMetrics> {
		const proposal = await this.pool.query<{
			proposals: string; approved: string; dismissed: string; duplicates: string;
			failures: string; reconciliations: string; review_failures: string;
			average_review_duration_ms: string | null;
			correction_flags: Record<string, number> | null;
		}>(
			`SELECT COUNT(*)::text AS proposals,
			 COUNT(*) FILTER (WHERE review_outcome IN ('approved','update','complete','reopen'))::text AS approved,
			 COUNT(*) FILTER (WHERE review_outcome='dismissed')::text AS dismissed,
			 COUNT(*) FILTER (WHERE review_outcome='duplicate')::text AS duplicates,
			 COUNT(*) FILTER (WHERE review_outcome IN ('failed','needs_reconciliation'))::text AS failures,
			 COUNT(*) FILTER (WHERE review_outcome='reconciled')::text AS reconciliations,
			 COALESCE(SUM(review_failure_count),0)::text AS review_failures,
			 AVG(review_duration_ms)::text AS average_review_duration_ms,
				 jsonb_build_object(${correctionFields.map(field => `'${field}', COALESCE(SUM(CASE WHEN correction_flags->>'${field}'='true' THEN 1 ELSE 0 END),0)`).join(", ")}) AS correction_flags
			 FROM task_proposals WHERE created_at >= now() - ($1::text || ' days')::interval`,
			[days],
		);
		const extraction = await this.pool.query<{
			average_latency_ms: string | null; total_tokens: string; invalid_outputs: string;
		}>(
			`SELECT AVG(latency_ms)::text AS average_latency_ms,
			 COALESCE(SUM(COALESCE((token_usage->>'totalTokens')::bigint,0)),0)::text AS total_tokens,
			 COUNT(*) FILTER (WHERE outcome='invalid_output')::text AS invalid_outputs
			 FROM ai_extraction_events WHERE created_at >= now() - ($1::text || ' days')::interval`,
			[days],
		);
		const p = proposal.rows[0];
		const e = extraction.rows[0];
		const proposals = Number(p?.proposals ?? 0);
		const approved = Number(p?.approved ?? 0);
		const reviewed = approved + Number(p?.dismissed ?? 0) + Number(p?.duplicates ?? 0) + Number(p?.failures ?? 0);
		const correctionCounts = p?.correction_flags ?? {};
		const rate = (count: number, total = reviewed) => total ? count / total : 0;
		return {
			days, proposals, approved,
			dismissed: Number(p?.dismissed ?? 0),
			duplicates: Number(p?.duplicates ?? 0),
			failures: Number(p?.failures ?? 0) + Number(p?.review_failures ?? 0),
			reconciliations: Number(p?.reconciliations ?? 0),
			approvalRate: rate(approved),
			duplicateRate: rate(Number(p?.duplicates ?? 0), proposals),
			assigneeAcceptanceRate: approved ? 1 - rate(Number(correctionCounts.assignee ?? 0), approved) : 0,
			deadlineAcceptanceRate: approved ? 1 - rate(Number(correctionCounts.dueDate ?? 0), approved) : 0,
			averageReviewDurationMs: Number(p?.average_review_duration_ms ?? 0),
			averageExtractionLatencyMs: Number(e?.average_latency_ms ?? 0),
			totalTokens: Number(e?.total_tokens ?? 0),
			invalidOutputs: Number(e?.invalid_outputs ?? 0),
			correctionRates: Object.fromEntries(correctionFields.map(field => [field, rate(Number(correctionCounts[field] ?? 0), approved)])) as Record<CorrectionField, number>,
		};
	}

	async cleanup(config: IntegrationConfig) {
		await this.pool.query(
			`DELETE FROM task_proposals WHERE openproject_work_package_id IS NULL
			 AND status <> 'needs_reconciliation'
			 AND ((status='pending_review' AND expires_at < now()) OR (
				 status IN ('dismissed','duplicate','failed')
				 AND updated_at < now() - ($1::text || ' days')::interval
			 ))`,
			[config.OPENPROJECT_AI_EVALUATION_RETENTION_DAYS],
		);
		await this.pool.query(
			`DELETE FROM task_drafts WHERE status IN ('created','failed')
			 AND updated_at < now() - ($1::text || ' days')::interval`,
			[config.OPENPROJECT_PROPOSAL_RETENTION_DAYS],
		);
		await this.pool.query(
			`DELETE FROM task_audit_log WHERE created_at < now() - ($1::text || ' days')::interval`,
			[config.OPENPROJECT_AUDIT_RETENTION_DAYS],
		);
		await this.pool.query(
			`DELETE FROM ai_extraction_events WHERE created_at < now() - ($1::text || ' days')::interval`,
			[config.OPENPROJECT_AI_EVALUATION_RETENTION_DAYS],
		);
		await this.pool.query(
			`DELETE FROM task_proposal_revisions WHERE created_at < now() - ($1::text || ' days')::interval`,
			[config.OPENPROJECT_AI_EVALUATION_RETENTION_DAYS],
		);
		await this.pool.query(
			`DELETE FROM scheduled_messages WHERE status IN ('sent','cancelled','failed')
			 AND updated_at < now() - interval '30 days'`,
		);
	}

	async logTaskEvent(workPackageId: number, event: string, actorId: string, metadata: Record<string, unknown> = {}) {
		await this.pool.query(
			"INSERT INTO task_audit_log(openproject_work_package_id,event,actor_discord_id,metadata) VALUES($1,$2,$3,$4)",
			[workPackageId, event, actorId, metadata],
		);
	}

	async queueConfirmation(workPackageId: number, channelId: string, assigneeDiscordId: string | undefined, error: string) {
		await this.pool.query(
			`INSERT INTO task_confirmation_queue(work_package_id,channel_id,assignee_discord_id,attempts,last_error)
			 VALUES($1,$2,$3,1,$4)
			 ON CONFLICT(work_package_id) DO UPDATE SET channel_id=excluded.channel_id,
			 assignee_discord_id=excluded.assignee_discord_id, attempts=task_confirmation_queue.attempts + 1,
			 last_error=excluded.last_error, updated_at=now()`,
			[workPackageId, channelId, assigneeDiscordId ?? null, error.slice(0, 1000)],
		);
	}

	async pendingConfirmation(workPackageId: number) {
		const result = await this.pool.query<{ assignee_discord_id: string | null }>(
			"SELECT assignee_discord_id FROM task_confirmation_queue WHERE work_package_id=$1",
			[workPackageId],
		);
		return result.rows[0];
	}

	async clearConfirmation(workPackageId: number) {
		await this.pool.query("DELETE FROM task_confirmation_queue WHERE work_package_id=$1", [workPackageId]);
	}

	async close() {
		await this.pool.end();
	}
}
