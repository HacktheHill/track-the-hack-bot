import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Message } from "discord.js";
import { containsSensitiveContent, minimizeText, StructuredOutputError, type MinimizedMessage, type TaskExtractor } from "./azure-openai.js";
import { isOrganizerGuild, type IntegrationConfig } from "./config.js";
import { Database } from "./database.js";
import { OpenProjectClient } from "./openproject.js";
import { appendVerbatimSources, defaultAiDueDate } from "./tasks.js";
import type { OpenProjectRag } from "./rag.js";

type AutomaticServices = { config: IntegrationConfig; db: Database; extractor: TaskExtractor; openProject: OpenProjectClient; rag?: OpenProjectRag };
type Batch = { messages: Message[]; timer: NodeJS.Timeout };

async function categoryProject(message: Message, services: AutomaticServices) {
	if (!message.inGuild()) return undefined;
	let channel = await message.guild.channels.fetch(message.channelId);
	for (let depth = 0; channel && depth < 3; depth++) {
		if (channel.type === ChannelType.GuildCategory) {
			return await services.db.categoryProject(channel.id) ?? services.config.categoryProjects[channel.id];
		}
		if (!channel.parentId) return undefined;
		channel = await message.guild.channels.fetch(channel.parentId);
	}
	return undefined;
}

async function isExternalChannel(message: Message, services: AutomaticServices) {
	if (!services.config.externalCategoryId) return false;
	let channel = await message.guild!.channels.fetch(message.channelId).catch(() => null);
	for (let depth = 0; channel && depth < 5; depth++) {
		if (channel.id === services.config.externalCategoryId) return true;
		if (!channel.parentId) break;
		channel = await message.guild!.channels.fetch(channel.parentId).catch(() => null);
	}
	return false;
}

export function registerAutomaticTaskDetection(client: Client, services: AutomaticServices) {
	if (services.config.OPENPROJECT_AUTOMATION_MODE === "off" || !services.extractor.enabled) return;
	const batches = new Map<string, Batch>();

	const flush = async (channelId: string) => {
		const batch = batches.get(channelId);
		if (!batch) return;
		batches.delete(channelId);
		const source = batch.messages.slice(-30);
		if (source[0] && await isExternalChannel(source[0], services)) return;
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
		const minimized: MinimizedMessage[] = source.map(message => {
			const raw = message.content.replace(/<@!?(\d+)>/g, (_, id: string) => aliasFor(id));
			return {
				id: message.id,
				channelId: message.channelId,
				authorAlias: aliasFor(message.author.id),
				text: minimizeText(raw),
				timestamp: message.createdAt.toISOString(),
					replyTo: message.reference?.messageId,
				attachments: [...message.attachments.values()].map(attachment => ({
					id: attachment.id,
					name: attachment.name ?? "attachment",
					contentType: attachment.contentType ?? undefined,
					url: attachment.url,
				})),
				containedSensitiveData: containsSensitiveContent([{ id: message.id, authorAlias: "", text: raw, timestamp: "" }]),
			};
		});
		try {
			const extraction = await services.extractor.extract(minimized);
			const { result, deployment } = extraction;
			let createdProposals = 0;
			let duplicates = 0;
			const sourceRecords = new Map(source.map(message => [message.id, {
				author: message.member?.displayName ?? message.author.username,
				timestamp: message.createdAt.toISOString(),
				text: message.content,
				attachments: [...message.attachments.values()].map(attachment => ({
					id: attachment.id,
					name: attachment.name ?? "attachment",
					contentType: attachment.contentType ?? undefined,
					url: attachment.url,
				})),
			}]));
			for (const task of result.tasks.filter(item =>
				item.proposed_action === "create" &&
				item.completion_state === "incomplete" &&
				item.significance_score >= services.config.OPENPROJECT_AI_SIGNIFICANCE_THRESHOLD &&
				["new_assignment", "clarification", "additional_requirements", "unclear"].includes(item.context_relation))) {
				if (!task.source_message_ids.every(id => source.some(message => message.id === id))) continue;
				const assigneeId = task.assignee_alias ? reverse.get(task.assignee_alias) : undefined;
				const accountableId = source.find(message => task.source_message_ids.includes(message.id))?.author.id;
				const projectId = source[0] ? await categoryProject(source[0], services) : undefined;
				const description = appendVerbatimSources(task.description, sourceRecords, task.source_message_ids);
				const similar = projectId && services.rag ? await services.rag.findSimilar(projectId, task.title, description) : [];
				const match = similar[0];
				if (match && match.similarity >= services.config.OPENPROJECT_RAG_SIMILARITY_THRESHOLD) {
					const reviewers = new Set<string>(source.filter(message => task.source_message_ids.includes(message.id)).map(message => message.author.id));
					if (assigneeId) reviewers.add(assigneeId);
					if (accountableId) reviewers.add(accountableId);
					for (const reviewer of [...reviewers]) if (!await services.db.openProjectUserId(reviewer)) reviewers.delete(reviewer);
					const proposal = await services.db.createProposal({
						channelId, projectId, title: task.title, description, assigneeDiscordId: assigneeId, accountableDiscordId: accountableId,
						dueDate: task.due_date ?? defaultAiDueDate(new Date(), undefined, undefined, services.config.BOT_TIME_ZONE),
						sourceMessageIds: task.source_message_ids, sourceLinks: task.source_message_ids.map(id => `https://discord.com/channels/${source[0]?.guildId ?? ""}/${source.find(item => item.id === id)?.channelId ?? channelId}/${id}`),
						classification: task.classification, modelDeployment: deployment, permittedReviewerIds: [...reviewers], evidence: task.evidence,
						ambiguities: [...result.ambiguities, `Possible existing task match: ${match.workPackageId}`], latencyMs: extraction.latencyMs, tokenUsage: extraction.usage,
						action: "update", targetWorkPackageId: match.workPackageId, targetLockVersion: match.lockVersion,
						initialSnapshot: { title: task.title, description, action: "update", targetWorkPackageId: match.workPackageId },
						retentionDays: services.config.OPENPROJECT_PROPOSAL_RETENTION_DAYS,
					});
					if (!proposal.reused && services.config.OPENPROJECT_AUTOMATION_MODE === "review") {
						const channel = source.at(-1)?.channel;
						if (channel?.isSendable()) await channel.send({
							content: `${assigneeId ? `<@${assigneeId}> ` : ""}${accountableId && accountableId !== assigneeId ? `<@${accountableId}> ` : ""}Proposed update to OpenProject task #${match.workPackageId}: **${task.title}**`,
							components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
								new ButtonBuilder().setCustomId(`op-review:${proposal.id}`).setLabel("Review and apply").setStyle(ButtonStyle.Primary),
								new ButtonBuilder().setCustomId(`op-dismiss:${proposal.id}`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary),
								new ButtonBuilder().setCustomId(`op-more-fields:${proposal.id}`).setLabel("More fields").setStyle(ButtonStyle.Secondary),
							)], allowedMentions: { users: [assigneeId, accountableId].filter((id): id is string => Boolean(id)) },
						});
					}
					createdProposals++;
					continue;
				}
				if (projectId && await services.openProject.possibleDuplicate(projectId, task.title)) {
					duplicates++;
					continue;
				}
				const citedIds = new Set(task.source_message_ids);
				const reviewers = new Set<string>(source.filter(message => citedIds.has(message.id)).map(message => message.author.id));
				if (assigneeId) reviewers.add(assigneeId);
				if (accountableId) reviewers.add(accountableId);
				for (const reviewer of [...reviewers]) {
					if (!await services.db.openProjectUserId(reviewer)) reviewers.delete(reviewer);
				}
				const proposal = await services.db.createProposal({
					channelId, projectId, title: task.title,
					description, assigneeDiscordId: assigneeId, accountableDiscordId: accountableId,
						dueDate: task.due_date ?? defaultAiDueDate(new Date(), undefined, undefined, services.config.BOT_TIME_ZONE), sourceMessageIds: task.source_message_ids,
						sourceLinks: task.source_message_ids.map(id => `https://discord.com/channels/${source[0]?.guildId ?? ""}/${source.find(item => item.id === id)?.channelId ?? channelId}/${id}`),
					classification: task.classification, modelDeployment: deployment,
					permittedReviewerIds: [...reviewers],
					evidence: task.evidence, ambiguities: result.ambiguities,
					latencyMs: extraction.latencyMs, tokenUsage: extraction.usage,
						escalationReason: extraction.escalationReason,
						initialSnapshot: { title: task.title, description, action: "create" },
						retentionDays: services.config.OPENPROJECT_PROPOSAL_RETENTION_DAYS,
				});
				if (proposal.reused) {
					duplicates++;
					continue;
				}
				createdProposals++;
				if (services.config.OPENPROJECT_AUTOMATION_MODE === "review") {
					const channel = source.at(-1)?.channel;
					if (channel?.isSendable()) {
						await channel.send({
					content: `${assigneeId ? `<@${assigneeId}> ` : ""}${accountableId && accountableId !== assigneeId ? `<@${accountableId}> ` : ""}Proposed OpenProject task: **${task.title}**\n${task.description}`,
							components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
								new ButtonBuilder().setCustomId(`op-review:${proposal.id}`).setLabel("Review and edit").setStyle(ButtonStyle.Primary),
								new ButtonBuilder().setCustomId(`op-dismiss:${proposal.id}`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary),
								new ButtonBuilder().setCustomId(`op-duplicate:${proposal.id}`).setLabel("Already tracked").setStyle(ButtonStyle.Secondary),
								new ButtonBuilder().setCustomId(`op-more-fields:${proposal.id}`).setLabel("More fields").setStyle(ButtonStyle.Secondary),
							)],
							allowedMentions: { users: [assigneeId, accountableId].filter((id): id is string => Boolean(id)) },
						});
					}
				}
			}
			await services.db.recordExtraction({
				source: "automatic",
				outcome: createdProposals ? "proposal" : duplicates ? "duplicate" : "no_task",
				modelDeployment: deployment,
				 taskCount: result.tasks.length,
				latencyMs: extraction.latencyMs,
				tokenUsage: extraction.usage,
				inputSnapshot: minimized.map(({ id, authorAlias, text, timestamp, contextRole }) => ({ id, authorAlias, text, timestamp, contextRole })),
				messageAssessments: result.message_assessments,
				decision: { taskCount: result.tasks.length, proposalCount: createdProposals, duplicateCount: duplicates },
			});
		} catch (error) {
			await services.db.recordExtraction({
				source: "automatic",
				outcome: error instanceof StructuredOutputError ? "invalid_output" : "error",
			}).catch(auditError => console.error("Automatic task extraction metrics failed", { channelId, error: (auditError as Error).message }));
			console.error("Automatic task extraction failed", { channelId, error: (error as Error).message });
		}
	};

	client.on("messageCreate", async message => {
		if (!message.inGuild() || !isOrganizerGuild(services.config, message.guildId) || message.author.bot || message.system) return;
		if (services.config.blockedChannels.has(message.channelId)) return;
		if (await isExternalChannel(message, services)) return;
		const existing = batches.get(message.channelId);
		if (existing) clearTimeout(existing.timer);
		const messages = [...(existing?.messages ?? []), message].slice(-30);
		const timer = setTimeout(() => void flush(message.channelId), services.config.OPENPROJECT_BATCH_IDLE_SECONDS * 1000);
		batches.set(message.channelId, { messages, timer });
	});
	console.log(`Automatic task extraction enabled in ${services.config.OPENPROJECT_AUTOMATION_MODE} mode`);
}
