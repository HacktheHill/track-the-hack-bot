import { z } from "zod";

const jsonRecord = <T>(name: string, fallback: T) => {
	const raw = process.env[name];
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new Error(`${name} must contain valid JSON`);
	}
};

const envSchema = z.object({
	OPENPROJECT_BASE_URL: z.url(),
	OPENPROJECT_API_KEY: z.string().min(1),
	DATABASE_URL: z.string().min(1),
	ORGANIZER_GUILD_ID: z.string().min(1),
	ORGANIZER_GUILD_MEMBER_ROLE_ID: z.string().min(1),
	ORGANIZER_GUILD_ORGANIZER_ROLE_ID: z.string().min(1),
	ORGANIZER_GUILD_EXECUTIVE_ROLE_ID: z.string().optional(),
	AZURE_OPENAI_ENDPOINT: z.url().optional(),
	AZURE_OPENAI_API_VERSION: z.string().default("v1"),
	AZURE_OPENAI_DEPLOYMENT: z.string().optional(),
	AZURE_OPENAI_EMBEDDING_DEPLOYMENT: z.string().optional(),
	AZURE_OPENAI_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().max(4096).optional(),
	AZURE_OPENAI_MAX_COMPLETION_TOKENS: z.coerce.number().int().min(64).max(4096).default(4096),
	OPENPROJECT_AI_MAX_CONTEXT_CHARS: z.coerce.number().int().min(2000).max(100000).default(16000),
	OPENPROJECT_AUTOMATION_MODE: z.enum(["off", "shadow", "review"]).default("off"),
	OPENPROJECT_RAG_MODE: z.enum(["off", "shadow", "review"]).default("off"),
	OPENPROJECT_AI_EVALUATION_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
	OPENPROJECT_EXTERNAL_CATEGORY_ID: z.string().optional(),
	OPENPROJECT_RAG_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(600),
	OPENPROJECT_RAG_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.55),
	OPENPROJECT_RUN_MIGRATIONS: z.string().default("false").transform(value => value.toLowerCase() === "true"),
	OPENPROJECT_AI_SIGNIFICANCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
	OPENPROJECT_BATCH_IDLE_SECONDS: z.coerce.number().int().min(30).default(300),
	OPENPROJECT_DEFAULT_DUE_DAYS: z.coerce.number().int().min(0).max(365).default(7),
	OPENPROJECT_DEFAULT_START_TODAY: z.string().default("true").transform(value => value.toLowerCase() === "true"),
	OPENPROJECT_SIZE_CUSTOM_FIELD: z.string().regex(/^customField\d+$/).default("customField2"),
	OPENPROJECT_DEFAULT_TYPE_NAME: z.string().default("Task"),
	OPENPROJECT_CACHE_TTL_MS: z.coerce.number().int().min(1000).max(3600000).default(300000),
	OPENPROJECT_PROPOSAL_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
	OPENPROJECT_AUDIT_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(365),
	OPENPROJECT_DRAFT_TTL_MINUTES: z.coerce.number().int().min(15).max(10080).default(1440),
	BOT_TIME_ZONE: z.string().min(1).default("America/Toronto"),
	OPENPROJECT_AI_MAX_IMAGE_ATTACHMENTS: z.coerce.number().int().min(0).max(20).default(8),
});

export type TeamMapping = {
	projectId: number;
	openProjectGroupId?: number;
	priority?: number;
	accountableDiscordId?: string;
};

export function loadIntegrationConfig() {
	const parsed = envSchema.safeParse(process.env);
	if (!parsed.success) return null;
	return {
		...parsed.data,
		userMap: jsonRecord<Record<string, number>>("OPENPROJECT_USER_MAP", {}),
		categoryProjects: jsonRecord<Record<string, number>>(
			"OPENPROJECT_CATEGORY_PROJECT_MAP",
			{},
		),
		teamRoles: jsonRecord<Record<string, TeamMapping>>(
			"OPENPROJECT_TEAM_ROLE_MAP",
			{},
		),
		blockedChannels: new Set(jsonRecord<string[]>("OPENPROJECT_BLOCKED_CHANNEL_IDS", [])),
		excludedChannelIds: new Set([
			...jsonRecord<string[]>("OPENPROJECT_BLOCKED_CHANNEL_IDS", []),
			...jsonRecord<string[]>("OPENPROJECT_EXCLUDED_CHANNEL_IDS", []),
			...(parsed.data.OPENPROJECT_EXTERNAL_CATEGORY_ID ? [parsed.data.OPENPROJECT_EXTERNAL_CATEGORY_ID] : []),
		]),
	};
}

export type IntegrationConfig = NonNullable<ReturnType<typeof loadIntegrationConfig>>;

const outreachSchema = z.object({
	OUTREACH_SERVICE_URL: z.url().refine(value => new URL(value).protocol === "https:", "must use HTTPS"),
	OUTREACH_DISCORD_KEY_ID: z.string().min(1).max(100),
	OUTREACH_DISCORD_SIGNING_SECRET: z.string().min(32),
	ORGANIZER_GUILD_ID: z.string().regex(/^\d{5,30}$/),
	ORGANIZER_GUILD_ORGANIZER_ROLE_ID: z.string().regex(/^\d{5,30}$/),
});
const outreachChannelIdsSchema = z.array(z.string().regex(/^\d{5,30}$/)).min(1);

export function loadOutreachConfig() {
	const names = [
		"OUTREACH_SERVICE_URL",
		"OUTREACH_DISCORD_KEY_ID",
		"OUTREACH_DISCORD_SIGNING_SECRET",
		"OUTREACH_DISCORD_ALLOWED_CHANNEL_IDS",
	] as const;
	if (names.every(name => !process.env[name])) return null;
	if (names.some(name => !process.env[name])) {
		throw new Error("Outreach integration configuration is incomplete");
	}
	const parsed = outreachSchema.parse(process.env);
	const channelIds = outreachChannelIdsSchema.safeParse(jsonRecord<unknown>("OUTREACH_DISCORD_ALLOWED_CHANNEL_IDS", []));
	if (!channelIds.success) {
		throw new Error("OUTREACH_DISCORD_ALLOWED_CHANNEL_IDS must contain Discord channel IDs");
	}
	return { ...parsed, allowedChannelIds: new Set(channelIds.data) };
}

export type OutreachConfig = NonNullable<ReturnType<typeof loadOutreachConfig>>;

export function isOrganizerGuild(config: Pick<IntegrationConfig, "ORGANIZER_GUILD_ID">, guildId?: string | null) {
	return guildId === config.ORGANIZER_GUILD_ID;
}
