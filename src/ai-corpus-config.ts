import { z } from "zod";

export const aiCorpusConfigSchema = z.object({
	AI_CORPUS_STORAGE_ACCOUNT_URL: z.url(),
	AI_CORPUS_CONTAINER: z.string().min(3).max(63).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).default("ai-evaluation"),
	AI_CORPUS_PREFIX: z.string().regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/).or(z.literal("")).default("track-the-hack-bot"),
	AI_CORPUS_UI_PORT: z.coerce.number().int().min(1024).max(65535).default(4178),
	AI_CORPUS_SYNC_DAYS: z.coerce.number().int().min(1).max(365).default(90),
	AI_CORPUS_NO_TASK_SAMPLE_LIMIT: z.coerce.number().int().min(0).max(500).default(25),
});

export type AiCorpusConfig = z.infer<typeof aiCorpusConfigSchema>;

export function loadAiCorpusConfig(environment: NodeJS.ProcessEnv = process.env) {
	return aiCorpusConfigSchema.parse(environment);
}
