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
				due_date DATE,
				source_message_ids TEXT[] NOT NULL DEFAULT '{}',
				source_fingerprint TEXT UNIQUE,
				classification TEXT,
				status TEXT NOT NULL DEFAULT 'draft',
				openproject_work_package_id INTEGER UNIQUE,
				reviewer_discord_id TEXT,
				model_deployment TEXT,
				permitted_reviewer_ids TEXT[] NOT NULL DEFAULT '{}',
				validation_result JSONB,
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
			CREATE TABLE IF NOT EXISTS discord_channel_projects (
				channel_id TEXT PRIMARY KEY,
				openproject_project_id INTEGER NOT NULL,
				updated_by_discord_id TEXT NOT NULL,
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)
		`);
		await this.pool.query("ALTER TABLE task_proposals ADD COLUMN IF NOT EXISTS permitted_reviewer_ids TEXT[] NOT NULL DEFAULT '{}'");
		await this.pool.query("ALTER TABLE task_audit_log ADD COLUMN IF NOT EXISTS openproject_work_package_id INTEGER");
		for (const [discordId, openProjectId] of Object.entries(config.userMap)) {
			await this.pool.query(
				`INSERT INTO discord_openproject_users(discord_user_id, openproject_user_id)
				 VALUES ($1,$2) ON CONFLICT(discord_user_id) DO UPDATE
				 SET openproject_user_id=excluded.openproject_user_id, updated_at=now()`,
				[discordId, openProjectId],
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

	async setOpenProjectUser(discordId: string, openProjectId: number) {
		await this.pool.query(
			`INSERT INTO discord_openproject_users(discord_user_id, openproject_user_id)
			 VALUES ($1,$2) ON CONFLICT(discord_user_id) DO UPDATE
			 SET openproject_user_id=excluded.openproject_user_id, updated_at=now()`,
			[discordId, openProjectId],
		);
	}

	async channelProject(channelId: string) {
		const result = await this.pool.query<{ openproject_project_id: number }>(
			"SELECT openproject_project_id FROM discord_channel_projects WHERE channel_id=$1",
			[channelId],
		);
		return result.rows[0]?.openproject_project_id;
	}

	async setChannelProject(channelId: string, projectId: number, actorId: string) {
		await this.pool.query(
			`INSERT INTO discord_channel_projects(channel_id,openproject_project_id,updated_by_discord_id)
			 VALUES($1,$2,$3) ON CONFLICT(channel_id) DO UPDATE SET
			 openproject_project_id=excluded.openproject_project_id,
			 updated_by_discord_id=excluded.updated_by_discord_id, updated_at=now()`,
			[channelId, projectId, actorId],
		);
	}

	async createProposal(input: {
		requesterId?: string;
		channelId: string;
		projectId?: number;
		title: string;
		description: string;
		assigneeDiscordId?: string;
		dueDate?: string;
		sourceMessageIds: string[];
		classification: string;
		modelDeployment: string;
		permittedReviewerIds?: string[];
	}) {
		const id = randomUUID();
		const fingerprint = [...input.sourceMessageIds].sort().join(":") + `:${input.title.toLowerCase()}`;
		const result = await this.pool.query<{ id: string }>(
			`INSERT INTO task_proposals
			(id, requester_discord_id, channel_id, project_id, title, description,
			 assignee_discord_id, due_date, source_message_ids, source_fingerprint,
			 classification, status, model_deployment, permitted_reviewer_ids)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending_review',$12,$13)
			ON CONFLICT(source_fingerprint) DO UPDATE SET updated_at=now()
			RETURNING id`,
			[id, input.requesterId, input.channelId, input.projectId ?? null, input.title,
			 input.description, input.assigneeDiscordId ?? null, input.dueDate ?? null,
			 input.sourceMessageIds, fingerprint, input.classification, input.modelDeployment,
			 input.permittedReviewerIds ?? (input.requesterId ? [input.requesterId] : [])],
		);
		return result.rows[0].id;
	}

	async proposal(id: string) {
		const result = await this.pool.query<{
			id: string; requester_discord_id: string | null; channel_id: string;
			project_id: number | null; title: string; description: string;
			assignee_discord_id: string | null; due_date: string | null;
			source_message_ids: string[]; status: string; permitted_reviewer_ids: string[];
		}>("SELECT * FROM task_proposals WHERE id=$1", [id]);
		return result.rows[0];
	}

	async setProposalStatus(id: string, status: string, reviewerId: string) {
		await this.pool.query(
			"UPDATE task_proposals SET status=$2, reviewer_discord_id=$3, updated_at=now() WHERE id=$1",
			[id, status, reviewerId],
		);
	}

	async markProposalCreated(id: string, reviewerId: string, workPackageId: number) {
		await this.pool.query(
			`UPDATE task_proposals SET status='created', reviewer_discord_id=$2,
			 openproject_work_package_id=$3, updated_at=now() WHERE id=$1`,
			[id, reviewerId, workPackageId],
		);
		await this.pool.query(
			"INSERT INTO task_audit_log(proposal_id,event,actor_discord_id,metadata) VALUES($1,'created',$2,$3)",
			[id, reviewerId, { workPackageId }],
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
