import pg from "pg";
import type { IntegrationConfig } from "./config.js";
import { randomUUID } from "node:crypto";

const { Pool } = pg;

export class Database {
	readonly pool: pg.Pool;

	constructor(url: string) {
		this.pool = new Pool({ connectionString: url, max: 5 });
	}

	async migrate(config: IntegrationConfig) {
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
			CREATE INDEX IF NOT EXISTS task_drafts_lookup_idx ON task_drafts(user_id, kind, status, expires_at)
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

	async categoryProject(categoryId: string) {
		const result = await this.pool.query<{ openproject_project_id: number }>(
			"SELECT openproject_project_id FROM discord_category_projects WHERE category_id=$1",
			[categoryId],
		);
		return result.rows[0]?.openproject_project_id;
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
	}) {
		const id = randomUUID();
		const fingerprint = [...input.sourceMessageIds].sort().join(":") + `:${input.title.toLowerCase()}`;
		const result = await this.pool.query<{ id: string }>(
			`INSERT INTO task_proposals
			(id, requester_discord_id, channel_id, project_id, title, description,
			 assignee_discord_id, accountable_discord_id, priority_id, size_href, start_date, due_date, estimated_hours,
			 source_message_ids, source_fingerprint, source_links,
			 classification, status, model_deployment, permitted_reviewer_ids,
			 evidence, ambiguities, latency_ms, token_usage, escalation_reason, expires_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'pending_review',$18,$19,$20,$21,$22,$23,$24,
			 now() + ($25::text || ' days')::interval)
			ON CONFLICT(source_fingerprint) DO UPDATE SET
			 requester_discord_id=excluded.requester_discord_id, channel_id=excluded.channel_id,
			 project_id=excluded.project_id, title=excluded.title, description=excluded.description,
			 assignee_discord_id=excluded.assignee_discord_id, accountable_discord_id=excluded.accountable_discord_id,
			 priority_id=excluded.priority_id,
			 size_href=excluded.size_href, start_date=excluded.start_date, due_date=excluded.due_date,
			 estimated_hours=excluded.estimated_hours,
				 source_message_ids=excluded.source_message_ids, source_links=excluded.source_links, classification=excluded.classification,
			 status='pending_review', model_deployment=excluded.model_deployment,
			 permitted_reviewer_ids=excluded.permitted_reviewer_ids, evidence=excluded.evidence,
			 ambiguities=excluded.ambiguities, latency_ms=excluded.latency_ms,
			 token_usage=excluded.token_usage, escalation_reason=excluded.escalation_reason,
			 reviewer_discord_id=NULL, openproject_work_package_id=NULL,
				 confirmation_message_id=NULL, error=NULL, expires_at=excluded.expires_at, updated_at=now()
			WHERE task_proposals.status IN ('dismissed','duplicate','failed')
			RETURNING id`,
			[id, input.requesterId, input.channelId, input.projectId ?? null, input.title,
			 input.description, input.assigneeDiscordId ?? null, input.accountableDiscordId ?? null,
			 input.priorityId ?? null, input.sizeHref ?? null,
			 input.startDate ?? null, input.dueDate ?? null, input.estimatedHours ?? null,
			 input.sourceMessageIds, fingerprint, input.sourceLinks ?? [], input.classification, input.modelDeployment,
				input.permittedReviewerIds ?? (input.requesterId ? [input.requesterId] : []),
				input.evidence ?? null, input.ambiguities ?? [], input.latencyMs ?? null,
				input.tokenUsage ?? null, input.escalationReason ?? null,
				input.retentionDays ?? 30],
		);
		if (result.rows[0]) return { id: result.rows[0].id, reused: false };
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
		}>("SELECT * FROM task_proposals WHERE id=$1", [id]);
		return result.rows[0];
	}

	async setProposalStatus(id: string, status: string, reviewerId: string) {
		const result = await this.pool.query(
			"UPDATE task_proposals SET status=$2, reviewer_discord_id=$3, updated_at=now() WHERE id=$1 AND status='pending_review' AND expires_at > now()",
			[id, status, reviewerId],
		);
		return result.rowCount === 1;
	}

	async claimProposal(id: string, reviewerId: string) {
		const result = await this.pool.query(
			`UPDATE task_proposals SET status='creating', reviewer_discord_id=$2, updated_at=now()
			 WHERE id=$1 AND status='pending_review' AND expires_at > now() RETURNING id`,
			[id, reviewerId],
		);
		return result.rowCount === 1;
	}

	async releaseProposal(id: string, error: string) {
		await this.pool.query(
			`UPDATE task_proposals SET status='pending_review', reviewer_discord_id=NULL,
			 error=$2, updated_at=now() WHERE id=$1 AND status='creating' AND expires_at > now()`,
			[id, error.slice(0, 1000)],
		);
	}

	async markProposalCreated(id: string, reviewerId: string, workPackageId: number, confirmationMessageId?: string) {
		await this.pool.query(
			`UPDATE task_proposals SET status='created', reviewer_discord_id=$2,
				 openproject_work_package_id=$3, confirmation_message_id=$4, error=NULL, updated_at=now() WHERE id=$1 AND status='creating'`,
			[id, reviewerId, workPackageId, confirmationMessageId ?? null],
		);
		await this.pool.query(
			"INSERT INTO task_audit_log(proposal_id,event,actor_discord_id,metadata) VALUES($1,'created',$2,$3)",
			[id, reviewerId, { workPackageId }],
		);
	}

	async markProposalFailed(id: string, status: "failed" | "needs_reconciliation", reviewerId: string, error: string) {
		await this.pool.query(
			"UPDATE task_proposals SET status=$2, reviewer_discord_id=$3, error=$4, updated_at=now() WHERE id=$1 AND status='creating'",
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

	async cleanup(config: IntegrationConfig) {
		await this.pool.query(
			`DELETE FROM task_proposals WHERE openproject_work_package_id IS NULL
			 AND status <> 'needs_reconciliation'
			 AND (expires_at < now() OR (
				 status IN ('dismissed','duplicate','failed')
				 AND updated_at < now() - ($1::text || ' days')::interval
			 ))`,
			[config.OPENPROJECT_PROPOSAL_RETENTION_DAYS],
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
	}

	async logTaskEvent(workPackageId: number, event: string, actorId: string, metadata: Record<string, unknown> = {}) {
		await this.pool.query(
			"INSERT INTO task_audit_log(openproject_work_package_id,event,actor_discord_id,metadata) VALUES($1,$2,$3,$4)",
			[workPackageId, event, actorId, metadata],
		);
	}

	async close() {
		await this.pool.end();
	}
}
