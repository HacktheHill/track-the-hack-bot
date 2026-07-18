import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Message } from "discord.js";
import { containsSensitiveContent, minimizeText, StructuredOutputError, type MinimizedMessage, type TaskExtractor } from "./azure-openai.js";
import { isOrganizerGuild, type IntegrationConfig } from "./config.js";
import { Database } from "./database.js";
import { OpenProjectClient } from "./openproject.js";
import { appendSourceLinks, boundedDiscordContent, defaultAiDueDate } from "./tasks.js";
import { resolveProposedAction, type OpenProjectRag } from "./rag.js";
import { describeProposalOperations, planExistingTaskOperations } from "./task-proposals.js";

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

async function isExcludedChannel(message: Message, services: AutomaticServices) {
	let channel = await message.guild!.channels.fetch(message.channelId).catch(() => null);
	for (let depth = 0; channel && depth < 5; depth++) {
		if (services.config.excludedChannelIds.has(channel.id)) return true;
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
		if (source[0] && await isExcludedChannel(source[0], services)) return;
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
			const projectId = source[0] ? await categoryProject(source[0], services) : undefined;
			const priorities = await services.openProject.priorities();
			const sizes = projectId ? await services.openProject.sizeOptions(projectId) : [];
			const extraction = await services.extractor.extract(minimized, {
				metadata: { priorities: priorities.map(priority => priority.name), sizes: sizes.map(size => size.value) },
			});
			const { result, deployment } = extraction;
			let createdProposals = 0;
			let duplicates = 0;
			const ragEvaluations: Array<{ title: string; proposedAction: string; workPackageId?: number; similarity?: number }> = [];
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
				item.proposed_action !== "no_action" &&
				(item.proposed_action !== "create" || item.completion_state === "incomplete") &&
				(item.proposed_action !== "complete" || item.completion_state === "completed") &&
				item.significance_score >= services.config.OPENPROJECT_AI_SIGNIFICANCE_THRESHOLD &&
				["new_assignment", "clarification", "additional_requirements", "status_update", "completion_evidence", "unclear"].includes(item.context_relation))) {
				if (!task.source_message_ids.every(id => source.some(message => message.id === id))) continue;
				const assigneeId = task.assignee_alias ? reverse.get(task.assignee_alias) : undefined;
				const accountableId = source.find(message => task.source_message_ids.includes(message.id))?.author.id;
				const priority = task.priority_name ? priorities.find(item => item.name.toLocaleLowerCase() === task.priority_name!.toLocaleLowerCase()) : undefined;
				const size = task.size_name ? sizes.find(item => item.value.toLocaleLowerCase() === task.size_name!.toLocaleLowerCase()) : undefined;
				const dueDate = task.due_date ?? defaultAiDueDate(new Date(), priority?.name, size?.value, services.config.BOT_TIME_ZONE);
				const sourceLinks = task.source_message_ids.map(id => `https://discord.com/channels/${source[0]?.guildId ?? ""}/${source.find(item => item.id === id)?.channelId ?? channelId}/${id}`);
				const description = appendSourceLinks(task.description, sourceRecords, task.source_message_ids, task.relevant_attachment_ids);
				const similar = projectId && services.rag ? await services.rag.findSimilar(projectId, task.title, description) : [];
				ragEvaluations.push({
					title: task.title, proposedAction: task.proposed_action,
					workPackageId: similar[0]?.workPackageId, similarity: similar[0]?.similarity,
				});
				const match = services.config.OPENPROJECT_RAG_MODE === "review" && similar[0]?.similarity >= services.config.OPENPROJECT_RAG_SIMILARITY_THRESHOLD ? similar[0] : undefined;
				const action = resolveProposedAction(task.proposed_action, services.config.OPENPROJECT_RAG_MODE, Boolean(match));
				if (action === "no_action") continue;
				if (action !== "create" && !match) continue;
				if (match && action !== "create") {
					const target = await services.openProject.workPackage(match.workPackageId);
					const operations = planExistingTaskOperations({
						workPackage: target,
						requestedAction: task.proposed_action === "no_action" ? "update" : task.proposed_action,
						contentIntent: task.content_intent,
						description,
						metadataFields: task.metadata_change_fields,
						values: {
							title: task.title, assigneeDiscordId: assigneeId, priorityId: priority?.id,
							sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined,
							startDate: task.start_date ?? undefined, dueDate: task.due_date ?? undefined,
							estimatedHours: task.estimated_hours ?? undefined,
						},
					});
					if (operations.contentOperation === "none" && Object.keys(operations.metadataPatch).length === 0) continue;
					const reviewers = new Set<string>(source.filter(message => task.source_message_ids.includes(message.id)).map(message => message.author.id));
					if (assigneeId) reviewers.add(assigneeId);
					if (accountableId) reviewers.add(accountableId);
					for (const reviewer of [...reviewers]) if (!await services.db.openProjectUserId(reviewer)) reviewers.delete(reviewer);
					const proposal = await services.db.createProposal({
						channelId, projectId, title: task.title, description, assigneeDiscordId: assigneeId, accountableDiscordId: accountableId,
						priorityId: priority?.id, sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined,
						startDate: task.start_date ?? undefined, dueDate, estimatedHours: task.estimated_hours ?? undefined,
						sourceMessageIds: task.source_message_ids, sourceLinks,
						classification: task.classification, modelDeployment: deployment, permittedReviewerIds: [...reviewers], evidence: task.evidence,
						ambiguities: [...result.ambiguities, `Possible existing task match: ${match.workPackageId}`], latencyMs: extraction.latencyMs, tokenUsage: extraction.usage,
						action, targetWorkPackageId: match.workPackageId, targetLockVersion: target.lockVersion,
						metadataPatch: operations.metadataPatch, contentOperation: operations.contentOperation,
						contentMarkdown: operations.contentMarkdown,
						initialSnapshot: {
							title: task.title, description, projectId, assigneeId, accountableId, priorityId: priority?.id,
							sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined, startDate: task.start_date,
							dueDate, estimatedHours: task.estimated_hours, action, targetWorkPackageId: match.workPackageId,
							sourceMessageIds: task.source_message_ids, sourceLinks,
						},
						retentionDays: services.config.OPENPROJECT_PROPOSAL_RETENTION_DAYS,
					});
					if (!proposal.reused && services.config.OPENPROJECT_AUTOMATION_MODE === "review") {
						const channel = source.at(-1)?.channel;
						if (channel?.isSendable()) try {
							await channel.send({
							content: boundedDiscordContent(`${assigneeId ? `<@${assigneeId}> ` : ""}${accountableId && accountableId !== assigneeId ? `<@${accountableId}> ` : ""}Proposed ${action} for OpenProject task #${match.workPackageId}: **${task.title}**\n${describeProposalOperations(operations.contentOperation, operations.metadataPatch).map(item => `- ${item}`).join("\n")}${operations.contentOperation === "descriptionReplacement" ? "\nThis will replace the canonical task description." : ""}`),
							components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
								new ButtonBuilder().setCustomId(`op-review:${proposal.id}`).setLabel("Review and apply").setStyle(ButtonStyle.Primary),
								new ButtonBuilder().setCustomId(`op-dismiss:${proposal.id}`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary),
							)], allowedMentions: { users: [assigneeId, accountableId].filter((id): id is string => Boolean(id)) },
							});
						} catch (error) {
							await services.db.markProposalDeliveryFailed(proposal.id, (error as Error).message);
							throw error;
						}
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
						priorityId: priority?.id, sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined,
						startDate: task.start_date ?? undefined, dueDate, estimatedHours: task.estimated_hours ?? undefined,
						sourceMessageIds: task.source_message_ids, sourceLinks,
					classification: task.classification, modelDeployment: deployment,
					permittedReviewerIds: [...reviewers],
					evidence: task.evidence, ambiguities: result.ambiguities,
					latencyMs: extraction.latencyMs, tokenUsage: extraction.usage,
						escalationReason: extraction.escalationReason,
						initialSnapshot: {
							title: task.title, description, projectId, assigneeId, accountableId, priorityId: priority?.id,
							sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined, startDate: task.start_date,
							dueDate, estimatedHours: task.estimated_hours, action: "create",
							sourceMessageIds: task.source_message_ids, sourceLinks,
						},
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
						try {
						await channel.send({
					content: boundedDiscordContent(`${assigneeId ? `<@${assigneeId}> ` : ""}${accountableId && accountableId !== assigneeId ? `<@${accountableId}> ` : ""}Proposed OpenProject task: **${task.title}**\n${description}`),
							components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
								new ButtonBuilder().setCustomId(`op-review:${proposal.id}`).setLabel("Review and edit").setStyle(ButtonStyle.Primary),
								new ButtonBuilder().setCustomId(`op-dismiss:${proposal.id}`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary),
								new ButtonBuilder().setCustomId(`op-duplicate:${proposal.id}`).setLabel("Already tracked").setStyle(ButtonStyle.Secondary),
							)],
							allowedMentions: { users: [assigneeId, accountableId].filter((id): id is string => Boolean(id)) },
						});
						} catch (error) {
							await services.db.markProposalDeliveryFailed(proposal.id, (error as Error).message);
							throw error;
						}
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
				triggerId: source.at(-1)?.id,
				inputSnapshot: minimized.map(({ id, authorAlias, text, timestamp, contextRole }) => ({ id, authorAlias, text, timestamp, contextRole })),
				messageAssessments: result.message_assessments,
				decision: { taskCount: result.tasks.length, proposalCount: createdProposals, duplicateCount: duplicates, ragEvaluations },
			});
		} catch (error) {
			await services.db.recordExtraction({
				source: "automatic",
				outcome: error instanceof StructuredOutputError ? "invalid_output" : "error",
				triggerId: source.at(-1)?.id,
				decision: { errorType: error instanceof StructuredOutputError ? "invalid_output" : "provider_error" },
			}).catch(auditError => console.error("Automatic task extraction metrics failed", { channelId, error: (auditError as Error).message }));
			console.error("Automatic task extraction failed", { channelId, error: (error as Error).message });
		}
	};

	client.on("messageCreate", async message => {
		if (!message.inGuild() || !isOrganizerGuild(services.config, message.guildId) || message.author.bot || message.system) return;
		if (await isExcludedChannel(message, services)) return;
		const existing = batches.get(message.channelId);
		if (existing) clearTimeout(existing.timer);
		const messages = [...(existing?.messages ?? []), message].slice(-30);
		const timer = setTimeout(() => void flush(message.channelId), services.config.OPENPROJECT_BATCH_IDLE_SECONDS * 1000);
		batches.set(message.channelId, { messages, timer });
	});
	console.log(`Automatic task extraction enabled in ${services.config.OPENPROJECT_AUTOMATION_MODE} mode`);
}
