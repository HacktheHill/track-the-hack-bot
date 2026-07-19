import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Message } from "discord.js";
import { automaticCandidateEligible, containsSensitiveContent, extractionDiagnostics, mergeRelatedTaskCandidates, minimizeText, SensitiveContentError, StructuredOutputError, type MinimizedMessage, type TaskExtractor } from "./azure-openai.js";
import { isOrganizerGuild, type IntegrationConfig } from "./config.js";
import { Database } from "./database.js";
import { OpenProjectClient, titlesLikelyDuplicate } from "./openproject.js";
import { AI_CONTEXT_GAP_MS, boundedDiscordContent, defaultAiDueDate, formatAiTaskDescription, inferCreationMetadata, teamProjectId } from "./tasks.js";
import { resolveProposalTarget, type OpenProjectRag } from "./rag.js";
import { describeProposalOperations, planExistingTaskOperations, taskReferencesAreValid } from "./task-proposals.js";

type AutomaticServices = { config: IntegrationConfig; db: Database; extractor: TaskExtractor; openProject: OpenProjectClient; rag?: OpenProjectRag };
type Batch = { messages: Message[]; timer: NodeJS.Timeout };

function messageTimestamp(value: unknown) {
	if (!value || typeof value !== "object") return undefined;
	if ("createdTimestamp" in value && typeof value.createdTimestamp === "number") return value.createdTimestamp;
	if ("timestamp" in value && typeof value.timestamp === "string") {
		const timestamp = Date.parse(value.timestamp);
		return Number.isFinite(timestamp) ? timestamp : undefined;
	}
	return undefined;
}

export function automaticFocalWindows<T>(messages: readonly T[], limit = 30, gapMs = AI_CONTEXT_GAP_MS) {
	return messages.map((focal, index) => {
		let segmentStart = index;
		while (segmentStart > 0) {
			const previous = messageTimestamp(messages[segmentStart - 1]);
			const current = messageTimestamp(messages[segmentStart]);
			if (previous !== undefined && current !== undefined && current - previous > gapMs) break;
			segmentStart--;
		}
		let segmentEnd = index + 1;
		while (segmentEnd < messages.length) {
			const previous = messageTimestamp(messages[segmentEnd - 1]);
			const current = messageTimestamp(messages[segmentEnd]);
			if (previous !== undefined && current !== undefined && current - previous > gapMs) break;
			segmentEnd++;
		}
		const before = Math.floor((limit - 1) / 2);
		let start = Math.max(segmentStart, index - before);
		let end = Math.min(segmentEnd, start + limit);
		start = Math.max(segmentStart, end - limit);
		return { messages: messages.slice(start, end), focal };
	});
}

async function enrichAutomaticContext(messages: Message[], focal: Message) {
	const roles = new Map<string, MinimizedMessage["contextRole"]>();
	const focalIndex = messages.findIndex(message => message.id === focal.id);
	for (const [index, message] of messages.entries()) {
		roles.set(message.id, message.id === focal.id ? "primary" : index < focalIndex ? "preceding" : "subsequent");
	}
	const extras = new Map<string, Message>();
	for (const message of messages) {
		if (!message.reference?.messageId || roles.has(message.reference.messageId) || extras.has(message.reference.messageId)) continue;
		const referenced = await message.fetchReference().catch(() => null);
		if (referenced) {
			extras.set(referenced.id, referenced);
			roles.set(referenced.id, "reply_target");
		}
	}
	if (focal.channel.isThread()) {
		const starter = await focal.channel.fetchStarterMessage().catch(() => null);
		if (starter && !roles.has(starter.id) && !extras.has(starter.id)) {
			extras.set(starter.id, starter);
			roles.set(starter.id, "thread_root");
		}
	}
	return { messages: [...extras.values(), ...messages], roles };
}

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
	const activeFlushes = new Map<string, Promise<void>>();

	const flush = async (channelId: string) => {
		const batch = batches.get(channelId);
		if (!batch) return;
		batches.delete(channelId);
		const batchSource = batch.messages.slice(-30);
		if (batchSource[0] && await isExcludedChannel(batchSource[0], services)) return;
		const seenCandidates: Array<{ title: string; action: string; projectId?: number; targetWorkPackageId?: number; assigneeId?: string }> = [];
		for (const window of automaticFocalWindows(batchSource, 8)) {
		const context = await enrichAutomaticContext(window.messages, window.focal);
		const source = context.messages;
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
		const primary = window.focal;
		const minimized: MinimizedMessage[] = source.map(message => {
			const raw = message.content.replace(/<@!?(\d+)>/g, (_, id: string) => aliasFor(id));
			return {
				id: message.id,
				channelId: message.channelId,
				authorAlias: aliasFor(message.author.id),
				text: minimizeText(raw),
				timestamp: message.createdAt.toISOString(),
				replyTo: message.reference?.messageId,
				priority: message.id === primary?.id,
				contextRole: context.roles.get(message.id),
				attachments: [...message.attachments.values()].map(attachment => ({
					id: attachment.id,
					name: attachment.name ?? "attachment",
					contentType: attachment.contentType ?? undefined,
					url: attachment.url,
				})),
				containedSensitiveData: containsSensitiveContent([{ id: message.id, authorAlias: "", text: raw, timestamp: "" }]),
			};
		});
		let completedExtraction: Awaited<ReturnType<TaskExtractor["extract"]>> | undefined;
		try {
			const channelProjectId = await categoryProject(primary, services);
			const priorities = await services.openProject.priorities();
			const sizes = channelProjectId ? await services.openProject.sizeOptions(channelProjectId) : [];
			const extraction = completedExtraction = await services.extractor.extract(minimized, {
				mode: "automatic",
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
			const validMessageIds = new Set(source.map(message => message.id));
			const focalMessageIds = new Set(primary ? [primary.id] : []);
			const validAttachmentIds = new Set(source.flatMap(message => [...message.attachments.keys()]));
			const individuallyGroundedTasks = result.tasks.filter(task => taskReferencesAreValid(task, validMessageIds, focalMessageIds, validAttachmentIds));
			const groundedTasks = mergeRelatedTaskCandidates(individuallyGroundedTasks);
			const eligibleTasks = groundedTasks.filter(automaticCandidateEligible);
			const candidateAssessments = groundedTasks.map(task => ({
				automaticEligibility: task.automatic_eligibility,
				triggerKind: task.trigger_kind,
				lifecycle: task.lifecycle,
				proposedAction: task.proposed_action,
				sourceMessageIds: task.source_message_ids,
			}));
			for (const task of eligibleTasks) {
				let projectId = channelProjectId;
				const assigneeId = task.assignee_alias ? reverse.get(task.assignee_alias) : undefined;
				if (!projectId && assigneeId) {
					const assignee = await primary.guild!.members.fetch(assigneeId).catch(() => null);
					projectId = teamProjectId(assignee, services.config.teamRoles);
				}
				const accountableId = source.find(message => task.source_message_ids.includes(message.id))?.author.id;
				let priority = task.priority_name ? priorities.find(item => item.name.toLocaleLowerCase() === task.priority_name!.toLocaleLowerCase()) : undefined;
				let estimatedHours = task.estimated_hours ?? undefined;
				const sourceLinks = task.source_message_ids.map(id => `https://discord.com/channels/${primary.guildId}/${source.find(item => item.id === id)?.channelId ?? channelId}/${id}`);
				const description = formatAiTaskDescription(task.description, minimized, sourceRecords, task.source_message_ids, task.relevant_attachment_ids);
				const similar = projectId && services.rag ? await services.rag.findSimilar(projectId, task.title, description) : [];
				ragEvaluations.push({
					title: task.title, proposedAction: task.proposed_action,
					workPackageId: similar[0]?.workPackageId, similarity: similar[0]?.similarity,
				});
				const suggestedMatch = services.config.OPENPROJECT_RAG_MODE === "review" && similar[0]?.similarity >= services.config.OPENPROJECT_RAG_SIMILARITY_THRESHOLD ? similar[0] : undefined;
				const targetResolution = await resolveProposalTarget({
					action: task.proposed_action,
					sourceTexts: task.source_message_ids.map(id => sourceRecords.get(id)?.text ?? ""),
					openProjectBaseUrl: services.config.OPENPROJECT_BASE_URL,
					projectId,
					ragMode: services.config.OPENPROJECT_RAG_MODE,
					suggestedMatch,
					workPackage: id => services.openProject.workPackage(id),
				});
				projectId = targetResolution.projectId;
				const { action, match, target } = targetResolution;
				if (action === "no_action") continue;
				if (action !== "create" && !match) continue;
				const candidateSizes = projectId === channelProjectId ? sizes : projectId ? await services.openProject.sizeOptions(projectId) : [];
				let size = task.size_name ? candidateSizes.find(item => item.value.toLocaleLowerCase() === task.size_name!.toLocaleLowerCase()) : undefined;
				const metadataInference = { priority: priority === undefined, size: size === undefined, estimate: estimatedHours === undefined };
				if (action === "create") {
					const inferredMetadata = inferCreationMetadata({
						title: task.title,
						description: task.description,
						dueDate: task.due_date,
						priorities,
						sizes: candidateSizes,
						priority,
						size,
						estimatedHours,
						timeZone: services.config.BOT_TIME_ZONE,
					});
					priority = inferredMetadata.priority;
					size = inferredMetadata.size;
					estimatedHours = inferredMetadata.estimatedHours;
				}
				const dueDate = task.due_date ?? defaultAiDueDate(new Date(), priority?.name, size?.value, services.config.BOT_TIME_ZONE);
				if (match && action !== "create") {
					const operations = planExistingTaskOperations({
						workPackage: target!,
						requestedAction: task.proposed_action,
						contentIntent: task.content_intent,
						description,
						metadataFields: task.metadata_change_fields,
						values: {
							title: task.title, assigneeDiscordId: assigneeId, priorityId: priority?.id,
							sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined,
							startDate: task.start_date ?? undefined, dueDate: task.due_date ?? undefined,
							estimatedHours,
						},
					});
					if (operations.contentOperation === "none" && Object.keys(operations.metadataPatch).length === 0) continue;
					if (seenCandidates.some(seen => seen.action === action && seen.projectId === projectId && seen.targetWorkPackageId === match.workPackageId && seen.assigneeId === assigneeId && titlesLikelyDuplicate(seen.title, task.title))) {
						duplicates++;
						continue;
					}
					const reviewers = new Set<string>(source.filter(message => task.source_message_ids.includes(message.id)).map(message => message.author.id));
					if (assigneeId) reviewers.add(assigneeId);
					if (accountableId) reviewers.add(accountableId);
					for (const reviewer of [...reviewers]) if (!await services.db.openProjectUserId(reviewer)) reviewers.delete(reviewer);
					const proposal = await services.db.createProposal({
						channelId, projectId, title: task.title, description, assigneeDiscordId: assigneeId, accountableDiscordId: accountableId,
						priorityId: priority?.id, sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined,
						startDate: task.start_date ?? undefined, dueDate, estimatedHours, metadataInference,
						sourceMessageIds: task.source_message_ids, sourceLinks,
						modelDeployment: deployment, permittedReviewerIds: [...reviewers], evidence: task.evidence,
						ambiguities: [...result.ambiguities, `Possible existing task match: ${match.workPackageId}`], latencyMs: extraction.latencyMs, tokenUsage: extraction.usage,
						action, targetWorkPackageId: match.workPackageId, targetLockVersion: target!.lockVersion,
						metadataPatch: operations.metadataPatch, contentOperation: operations.contentOperation,
						contentMarkdown: operations.contentMarkdown,
						initialSnapshot: {
							title: task.title, description, projectId, assigneeId, accountableId, priorityId: priority?.id,
							sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined, startDate: task.start_date,
							dueDate, estimatedHours: estimatedHours ?? null, action, targetWorkPackageId: match.workPackageId,
							sourceMessageIds: task.source_message_ids, sourceLinks,
						},
						retentionDays: services.config.OPENPROJECT_PROPOSAL_RETENTION_DAYS,
					});
					if (proposal.reused) {
						duplicates++;
						continue;
					}
					seenCandidates.push({ title: task.title, action, projectId, targetWorkPackageId: match.workPackageId, assigneeId });
					if (services.config.OPENPROJECT_AUTOMATION_MODE === "review") {
						const channel = primary.channel;
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
				const advisory = suggestedMatch
					? `Possible existing task: #${suggestedMatch.workPackageId} (${Math.round(suggestedMatch.similarity * 100)}% similarity). This proposal will still create a new task.`
					: undefined;
				const citedIds = new Set(task.source_message_ids);
				const reviewers = new Set<string>(source.filter(message => citedIds.has(message.id)).map(message => message.author.id));
				if (assigneeId) reviewers.add(assigneeId);
				if (accountableId) reviewers.add(accountableId);
				for (const reviewer of [...reviewers]) {
					if (!await services.db.openProjectUserId(reviewer)) reviewers.delete(reviewer);
				}
				if (seenCandidates.some(seen => seen.action === action && seen.projectId === projectId && seen.targetWorkPackageId === undefined && seen.assigneeId === assigneeId && titlesLikelyDuplicate(seen.title, task.title))) {
					duplicates++;
					continue;
				}
				const proposal = await services.db.createProposal({
					channelId, projectId, title: task.title,
						description, assigneeDiscordId: assigneeId, accountableDiscordId: accountableId,
						priorityId: priority?.id, sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined,
						startDate: task.start_date ?? undefined, dueDate, estimatedHours, metadataInference,
						sourceMessageIds: task.source_message_ids, sourceLinks,
					modelDeployment: deployment,
					permittedReviewerIds: [...reviewers],
					evidence: task.evidence, ambiguities: [...result.ambiguities, ...(advisory ? [advisory] : [])],
					latencyMs: extraction.latencyMs, tokenUsage: extraction.usage,
						escalationReason: extraction.escalationReason,
						initialSnapshot: {
							title: task.title, description, projectId, assigneeId, accountableId, priorityId: priority?.id,
							sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined, startDate: task.start_date,
							dueDate, estimatedHours: estimatedHours ?? null, action: "create",
							sourceMessageIds: task.source_message_ids, sourceLinks,
						},
						retentionDays: services.config.OPENPROJECT_PROPOSAL_RETENTION_DAYS,
				});
				if (proposal.reused) {
					duplicates++;
					continue;
				}
				seenCandidates.push({ title: task.title, action, projectId, assigneeId });
				createdProposals++;
				if (services.config.OPENPROJECT_AUTOMATION_MODE === "review") {
					const channel = primary.channel;
					if (channel?.isSendable()) {
						try {
						await channel.send({
							content: boundedDiscordContent(`${assigneeId ? `<@${assigneeId}> ` : ""}${accountableId && accountableId !== assigneeId ? `<@${accountableId}> ` : ""}Proposed OpenProject task: **${task.title}**\n${description}${advisory ? `\n\n${advisory}` : ""}`),
							components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
								new ButtonBuilder().setCustomId(`op-review:${proposal.id}`).setLabel("Review and edit").setStyle(ButtonStyle.Primary),
								...(suggestedMatch ? [new ButtonBuilder().setCustomId(`op-use-existing:${proposal.id}:${suggestedMatch.workPackageId}`).setLabel(`Use existing #${suggestedMatch.workPackageId}`).setStyle(ButtonStyle.Secondary)] : []),
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
				triggerId: primary.id,
				inputSnapshot: extraction.inputMessages.map(({ containedSensitiveData: _, ...message }) => message),
				messageAssessments: candidateAssessments,
				decision: {
					taskCount: result.tasks.length,
					groundedCount: individuallyGroundedTasks.length,
					groupedCount: groundedTasks.length,
					eligibleCount: eligibleTasks.length,
					rejectedCount: groundedTasks.length - eligibleTasks.length,
					invalidGroundingCount: result.tasks.length - individuallyGroundedTasks.length,
					extractionMetadata: extraction.metadata,
					extractionOptions: extraction.replayOptions,
					proposalCount: createdProposals,
					duplicateCount: duplicates,
					ragEvaluations,
				},
			});
		} catch (error) {
			const diagnostics = extractionDiagnostics(error) ?? (completedExtraction ? {
				inputMessages: completedExtraction.inputMessages,
				metadata: completedExtraction.metadata,
				replayOptions: completedExtraction.replayOptions,
				stage: "processing" as const,
			} : undefined);
			const retainSnapshot = !(error instanceof SensitiveContentError) || Boolean(diagnostics?.replayOptions.allowSensitiveContent);
			await services.db.recordExtraction({
				source: "automatic",
				outcome: error instanceof StructuredOutputError ? "invalid_output" : error instanceof SensitiveContentError ? "sensitive_block" : "error",
				triggerId: primary.id,
				inputSnapshot: retainSnapshot ? diagnostics?.inputMessages.map(({ containedSensitiveData: _, ...message }) => message) : undefined,
				decision: error instanceof SensitiveContentError
					? { errorType: "sensitive_block", reasons: error.reasons, extractionMetadata: diagnostics?.metadata, extractionOptions: diagnostics?.replayOptions }
					: { errorType: !diagnostics || diagnostics.stage === "processing" ? "processing_error" : error instanceof StructuredOutputError ? "invalid_output" : "provider_error", extractionMetadata: diagnostics?.metadata, extractionOptions: diagnostics?.replayOptions },
			}).catch(auditError => console.error("Automatic task extraction metrics failed", { channelId, error: (auditError as Error).message }));
			console.error("Automatic task extraction failed", { channelId, error: (error as Error).message });
		}
		}
	};
	const enqueueFlush = (channelId: string) => {
		const previous = activeFlushes.get(channelId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(() => flush(channelId)).catch(error => {
			console.error("Automatic task extraction flush failed", { channelId, error: (error as Error).message });
		}).finally(() => {
			if (activeFlushes.get(channelId) === next) activeFlushes.delete(channelId);
		});
		activeFlushes.set(channelId, next);
	};

	client.on("messageCreate", async message => {
		if (!message.inGuild() || !isOrganizerGuild(services.config, message.guildId) || message.author.bot || message.system) return;
		if (await isExcludedChannel(message, services)) return;
		const existing = batches.get(message.channelId);
		if (existing) clearTimeout(existing.timer);
		const messages = [...(existing?.messages ?? []), message].slice(-30);
		const timer = setTimeout(() => enqueueFlush(message.channelId), services.config.OPENPROJECT_BATCH_IDLE_SECONDS * 1000);
		batches.set(message.channelId, { messages, timer });
	});
	console.log(`Automatic task extraction enabled in ${services.config.OPENPROJECT_AUTOMATION_MODE} mode`);
}
