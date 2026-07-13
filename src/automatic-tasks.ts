import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Message } from "discord.js";
import { minimizeText, type MinimizedMessage, type TaskExtractor } from "./azure-openai.js";
import type { IntegrationConfig } from "./config.js";
import { Database } from "./database.js";
import { OpenProjectClient } from "./openproject.js";

type AutomaticServices = { config: IntegrationConfig; db: Database; extractor: TaskExtractor; openProject: OpenProjectClient };
type Batch = { messages: Message[]; timer: NodeJS.Timeout };

export function registerAutomaticTaskDetection(client: Client, services: AutomaticServices) {
	if (services.config.OPENPROJECT_AUTOMATION_MODE === "off" || !services.extractor.enabled) return;
	const batches = new Map<string, Batch>();

	const flush = async (channelId: string) => {
		const batch = batches.get(channelId);
		if (!batch) return;
		batches.delete(channelId);
		const source = batch.messages.slice(-30);
		const aliases = new Map<string, string>();
		const reverse = new Map<string, string>();
		const aliasFor = (id: string) => {
			let alias = aliases.get(id);
			if (!alias) {
				alias = `USER_${aliases.size + 1}`;
				aliases.set(id, alias);
				reverse.set(alias, id);
			}
			return alias;
		};
		const minimized: MinimizedMessage[] = source.map(message => ({
			id: message.id,
			authorAlias: aliasFor(message.author.id),
			text: minimizeText(message.content.replace(/<@!?(\d+)>/g, (_, id: string) => aliasFor(id))),
			timestamp: message.createdAt.toISOString(),
			replyTo: message.reference?.messageId,
		}));
		try {
			const { result, deployment } = await services.extractor.extract(minimized);
			for (const task of result.tasks.filter(item => item.classification === "explicit_commitment" || item.classification === "direct_assignment")) {
				if (!task.source_message_ids.every(id => source.some(message => message.id === id))) continue;
				const assigneeId = task.assignee_alias ? reverse.get(task.assignee_alias) : undefined;
				const projectId = await services.db.channelProject(channelId) ?? services.config.channelProjects[channelId];
				if (projectId && await services.openProject.possibleDuplicate(projectId, task.title)) continue;
				const reviewers = new Set<string>(source.map(message => message.author.id));
				if (assigneeId) reviewers.add(assigneeId);
				for (const reviewer of [...reviewers]) {
					if (!await services.db.openProjectUserId(reviewer)) reviewers.delete(reviewer);
				}
				const proposalId = await services.db.createProposal({
					channelId, projectId, title: task.title,
					description: task.description, assigneeDiscordId: assigneeId,
					dueDate: task.due_date ?? undefined, sourceMessageIds: task.source_message_ids,
					classification: task.classification, modelDeployment: deployment,
					permittedReviewerIds: [...reviewers],
				});
				if (services.config.OPENPROJECT_AUTOMATION_MODE === "review") {
					const channel = source.at(-1)?.channel;
					if (channel?.isSendable()) {
						await channel.send({
							content: `Proposed OpenProject task: **${task.title}**\n${task.description}`,
							components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
								new ButtonBuilder().setCustomId(`op-review:${proposalId}`).setLabel("Review and edit").setStyle(ButtonStyle.Primary),
								new ButtonBuilder().setCustomId(`op-dismiss:${proposalId}`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary),
							)],
							allowedMentions: { parse: [] },
						});
					}
				}
			}
		} catch (error) {
			console.error("Automatic task extraction failed", { channelId, error: (error as Error).message });
		}
	};

	client.on("messageCreate", message => {
		if (!message.inGuild() || message.author.bot || message.system) return;
		if (!services.config.aiChannels.has(message.channelId) || services.config.blockedChannels.has(message.channelId)) return;
		const existing = batches.get(message.channelId);
		if (existing) clearTimeout(existing.timer);
		const messages = [...(existing?.messages ?? []), message].slice(-30);
		const timer = setTimeout(() => void flush(message.channelId), services.config.OPENPROJECT_BATCH_IDLE_SECONDS * 1000);
		batches.set(message.channelId, { messages, timer });
	});
	console.log(`Automatic task extraction enabled in ${services.config.OPENPROJECT_AUTOMATION_MODE} mode`);
}
