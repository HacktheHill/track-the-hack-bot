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
	OPENPROJECT_BASE_URL: z.string().url(),
	OPENPROJECT_API_KEY: z.string().min(1),
	DATABASE_URL: z.string().min(1),
	ORGANIZER_GUILD_ID: z.string().min(1),
	ORGANIZER_GUILD_ORGANIZER_ROLE_ID: z.string().min(1),
	ORGANIZER_GUILD_EXECUTIVE_ROLE_ID: z.string().optional(),
	AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
	AZURE_OPENAI_API_VERSION: z.string().default("2025-04-01-preview"),
	AZURE_OPENAI_NANO_DEPLOYMENT: z.string().optional(),
	AZURE_OPENAI_MINI_DEPLOYMENT: z.string().optional(),
	OPENPROJECT_AUTOMATION_MODE: z.enum(["off", "shadow", "review"]).default("off"),
	OPENPROJECT_BATCH_IDLE_SECONDS: z.coerce.number().int().min(30).default(300),
	OPENPROJECT_DEFAULT_DUE_DAYS: z.coerce.number().int().min(0).max(365).default(7),
	OPENPROJECT_DEFAULT_START_TODAY: z.string().default("true").transform(value => value.toLowerCase() === "true"),
	OPENPROJECT_SIZE_CUSTOM_FIELD: z.string().regex(/^customField\d+$/).default("customField2"),
	OPENPROJECT_DEFAULT_TYPE_NAME: z.string().default("Task"),
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
		channelProjects: jsonRecord<Record<string, number>>(
			"OPENPROJECT_CHANNEL_PROJECT_MAP",
			{},
		),
		teamRoles: jsonRecord<Record<string, TeamMapping>>(
			"OPENPROJECT_TEAM_ROLE_MAP",
			{},
		),
		blockedChannels: new Set(
			jsonRecord<string[]>("OPENPROJECT_BLOCKED_CHANNEL_IDS", []),
		),
		aiChannels: new Set(jsonRecord<string[]>("OPENPROJECT_AI_CHANNEL_IDS", [])),
	};
}

export type IntegrationConfig = NonNullable<ReturnType<typeof loadIntegrationConfig>>;
