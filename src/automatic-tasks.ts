import { Client, Message, PermissionFlagsBits, type MessageCreateOptions } from "discord.js";
import { automaticCandidateEligible, containsSensitiveContent, extractionDiagnostics, mergeRelatedTaskCandidates, minimizeText, SensitiveContentError, shouldReconcileTaskProposals, shouldSelectTaskContext, StructuredOutputError, type ContextSelectionResult, type MinimizedMessage, type ProposalReconciliationResult, type TaskExtractor } from "./azure-openai.js";
import { isOrganizerGuild, type IntegrationConfig } from "./config.js";
import { Database } from "./database.js";
import { OpenProjectClient, titlesLikelyDuplicate, workPackageMarkdownLink } from "./openproject.js";
import { AI_CONTEXT_GAP_MS, defaultAiDueDate, formatAiTaskDescription, inferCreationMetadata, proposalReviewAllowed, proposalReviewCardContent, proposalReviewComponents, relevantImageAttachments, resolveOptionalOwner } from "./tasks.js";
import { resolveProposalTarget, type OpenProjectRag } from "./rag.js";
import { describeProposalOperations, formatProposalContent, planExistingTaskOperations, sourceContentHash, taskReferencesAreValid } from "./task-proposals.js";
import { isExcludedChannel, projectIdForTeamRoles, projectIdFromChannelNames, resolveProjectId } from "./project-resolution.js";

type AutomaticServices = { config: IntegrationConfig; db: Database; extractor: TaskExtractor; openProject: OpenProjectClient; rag?: OpenProjectRag };
type Batch = { messages: Message[]; reconciliationSourceIds: Set<string>; timer: NodeJS.Timeout };
type ReviewCardPayload = Pick<MessageCreateOptions, "content" | "components" | "allowedMentions">;

function combinedUsage(...usages: Array<{ promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined>) {
	const values = usages.filter((usage): usage is NonNullable<typeof usage> => Boolean(usage));
	if (!values.length) return undefined;
	return {
		promptTokens: values.reduce((total, usage) => total + (usage.promptTokens ?? 0), 0),
		completionTokens: values.reduce((total, usage) => total + (usage.completionTokens ?? 0), 0),
		totalTokens: values.reduce((total, usage) => total + (usage.totalTokens ?? 0), 0),
	};
}

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

export function automaticBatchSource<T>(messages: readonly T[], limit = 6) {
	return messages.slice(-limit);
}

export function proposalOwnerText(assigneeName?: string, accountableName?: string) {
	const owners = [...new Set([
		assigneeName ? `Assignee: ${assigneeName}` : undefined,
		accountableName ? `Accountable: ${accountableName}` : undefined,
	].filter((value): value is string => Boolean(value)))];
	return owners.length ? `${owners.join(" | ")}\n` : "";
}

export function messageRevisionChanged(previousContent: string | undefined, currentContent: string, previousAttachments: string, currentAttachments: string) {
	return previousContent === undefined || previousContent !== currentContent || previousAttachments !== currentAttachments;
}

export function sourceEditShouldReconcile(mode: IntegrationConfig["OPENPROJECT_AUTOMATION_MODE"], affectedProposalIds: readonly string[]) {
	return mode === "review" || affectedProposalIds.length > 0;
}

export function reconciledSupersessionIds(input: {
	reconciledCount: number;
	eligibleCount: number;
	extractedCount: number;
	reconciliationSucceeded: boolean;
	persistedProposalIds: ReadonlySet<string>;
	recommendedSupersessionIds: string[];
	invalidatableProposalIds: string[];
}) {
	if (input.reconciledCount === 1 && input.eligibleCount === 1 && input.persistedProposalIds.size > 0) {
		return input.recommendedSupersessionIds.filter(id => !input.persistedProposalIds.has(id));
	}
	return [];
}

async function updateStoredReviewCard(primary: Message, services: AutomaticServices, proposalId: string, payload: ReviewCardPayload) {
	const proposal = await services.db.proposal(proposalId);
	if (!proposal?.review_message_id) return false;
	const channel = await primary.client.channels.fetch(proposal.channel_id).catch(() => null);
	if (!channel?.isTextBased() || !("messages" in channel)) {
		await services.db.markProposalDeliveryFailed(proposalId, "The revised proposal review channel is unavailable.");
		throw new Error("The revised proposal review channel is unavailable.");
	}
	let message: Message | undefined;
	try {
		message = await channel.messages.fetch(proposal.review_message_id);
	} catch (error) {
		if (!(error && typeof error === "object" && "code" in error && error.code === 10008)) {
			await services.db.markProposalDeliveryFailed(proposalId, `Could not fetch the revised proposal review card: ${(error as Error).message}`);
			throw error;
		}
	}
	if (message) {
		try {
			await message.edit(payload);
			return true;
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === 10008)) {
				await services.db.markProposalDeliveryFailed(proposalId, `Could not update the revised proposal review card: ${(error as Error).message}`);
				throw error;
			}
		}
	}
	if (!channel.isSendable()) throw new Error("The revised proposal review channel cannot accept a replacement card.");
	const replacement = await channel.send(payload);
	if (!await services.db.replaceProposalReviewMessage(proposalId, proposal.review_message_id, replacement.id)) {
		await replacement.delete().catch(() => undefined);
		throw new Error("The revised proposal was handled before its replacement review card could be attached.");
	}
	return true;
}

async function enrichAutomaticContext(messages: Message[], focal: Message) {
	const roles = new Map<string, MinimizedMessage["contextRole"]>();
	const focalIndex = messages.findIndex(message => message.id === focal.id);
	for (const [index, message] of messages.entries()) {
		roles.set(message.id, message.id === focal.id ? "primary" : index < focalIndex ? "preceding" : "subsequent");
	}
	const extras = new Map<string, Message>();
	const add = (message: Message, role: MinimizedMessage["contextRole"]) => {
		if (roles.has(message.id) || extras.has(message.id) || extras.size + messages.length >= 60 || message.author.bot || message.system) return;
		extras.set(message.id, message);
		roles.set(message.id, role);
	};
	const queue = [focal];
	if (focal.channel.isThread()) {
		const starter = await focal.channel.fetchStarterMessage().catch(() => null);
		if (starter) {
			add(starter, "thread_root");
			queue.push(starter);
		}
	}
	let visited = 0;
	for (const anchor of queue) {
		if (visited++ >= 6 || extras.size + messages.length >= 60) break;
		if (anchor.reference?.messageId) {
			const referenced = await anchor.fetchReference().catch(() => null);
			if (referenced && !roles.has(referenced.id) && !extras.has(referenced.id)) {
				add(referenced, "reply_target");
				queue.push(referenced);
			}
		}
	}
	for (const anchor of queue.slice(0, 6)) {
		if (extras.size + messages.length >= 60) break;
		if (!("messages" in anchor.channel)) continue;
		const nearby = await anchor.channel.messages.fetch({ around: anchor.id, limit: 9 }).catch(() => null);
		for (const message of [...(nearby?.values() ?? [])]
			.filter(message => message.createdTimestamp < anchor.createdTimestamp)
			.sort((left, right) => right.createdTimestamp - left.createdTimestamp)) add(message, "preceding");
		for (const message of [...(nearby?.values() ?? [])]
			.filter(message => message.createdTimestamp > anchor.createdTimestamp)
			.sort((left, right) => left.createdTimestamp - right.createdTimestamp)) add(message, "subsequent");
	}
	return { messages: [...extras.values(), ...messages].sort((left, right) => left.createdTimestamp - right.createdTimestamp), roles };
}

export function registerAutomaticTaskDetection(client: Client, services: AutomaticServices) {
	const batches = new Map<string, Batch>();
	const activeFlushes = new Map<string, Promise<void>>();

	const flush = async (channelId: string) => {
		const batch = batches.get(channelId);
		if (!batch) return;
		batches.delete(channelId);
		if (!services.extractor.enabled) return;
		const sourceReconciliation = batch.reconciliationSourceIds.size > 0;
		const batchSource = automaticBatchSource(batch.messages);
		if (batchSource[0] && await isExcludedChannel(batchSource[0].channelId, batchSource[0].guild!, services.config.excludedChannelIds)) return;
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
		const minimizedCandidates: MinimizedMessage[] = source.map(message => {
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
		let completedGate: Awaited<ReturnType<TaskExtractor["assessAutomaticCandidates"]>> | undefined;
		try {
			const projects = await services.openProject.projects();
			const channelProjectId = await projectIdFromChannelNames(primary.channelId, primary.guild!, projects);
			const priorities = await services.openProject.priorities();
			const sizes = channelProjectId ? await services.openProject.sizeOptions(channelProjectId) : [];
			const fallbackIds = new Set([
				...window.messages.map(message => message.id),
				...minimizedCandidates.filter(message => message.contextRole === "reply_target" || message.contextRole === "thread_root").map(message => message.id),
			]);
			const needsContextSelection = shouldSelectTaskContext(minimizedCandidates.length);
			let contextSelection: ContextSelectionResult = {
				messages: needsContextSelection ? minimizedCandidates.filter(message => fallbackIds.has(message.id)) : minimizedCandidates,
				deployment: "deterministic", latencyMs: 0,
			};
			if (services.extractor.selectContext && needsContextSelection) try {
				contextSelection = await services.extractor.selectContext(minimizedCandidates, [primary.id]);
			} catch (error) {
				console.warn("Automatic AI context selection failed; using the bounded collected graph", { error: (error as Error).message });
			}
			const minimized = contextSelection.messages;
			const extraction = completedExtraction = await services.extractor.extract(minimized, {
				mode: "automatic",
				metadata: { priorities: priorities.map(priority => priority.name), sizes: sizes.map(size => size.value), projects: projects.map(project => project.name) },
			});
			const { result, deployment } = extraction;
			let createdProposals = 0;
			let duplicates = 0;
			let revisedProposals = 0;
			const proposalIds = new Set<string>();
			const ragEvaluations: Array<Record<string, unknown>> = [];
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
			const groupedTasks = mergeRelatedTaskCandidates(individuallyGroundedTasks);
			const primaryMember = primary.member ?? await primary.guild!.members.fetch(primary.author.id).catch(() => null);
			const pendingProposals = (await services.db.pendingProposalContexts(channelId)).filter(proposal => proposalReviewAllowed(
				primary.author.id, proposal.permittedReviewerIds, proposal.requesterDiscordId ?? null,
				primaryMember?.roles.cache.has(services.config.ORGANIZER_GUILD_ORGANIZER_ROLE_ID),
				primaryMember?.permissions.has(PermissionFlagsBits.ManageGuild),
			));
			const permittedExistingProposalIds = pendingProposals.map(proposal => proposal.id);
			const affectedPendingProposalIds = pendingProposals.filter(proposal => proposal.sourceMessageIds.includes(primary.id)).map(proposal => proposal.id);
			const invalidatablePendingProposalIds = pendingProposals
				.filter(proposal => proposal.sourceMessageIds.length === 1 && proposal.sourceMessageIds[0] === primary.id)
				.map(proposal => proposal.id);
			let reconciliation: ProposalReconciliationResult = {
				proposals: groupedTasks.map(candidate => ({ candidate })),
				supersededPendingProposalIds: [], deployment: "deterministic", latencyMs: 0,
			};
			let reconciliationSucceeded = false;
			if (services.extractor.reconcileProposals && shouldReconcileTaskProposals(groupedTasks.length, pendingProposals.length)) try {
				reconciliation = await services.extractor.reconcileProposals(extraction.inputMessages, groupedTasks, pendingProposals, affectedPendingProposalIds);
				reconciliationSucceeded = true;
			} catch (error) {
				console.warn("Automatic AI proposal reconciliation failed; using grounded candidates", { error: (error as Error).message });
			}
			const reconciledTasks = reconciliation.proposals;
			const gate = completedGate = await services.extractor.assessAutomaticCandidates(extraction.inputMessages, reconciledTasks.map(item => item.candidate));
			const eligibleTasks = reconciledTasks.filter((item, index) => automaticCandidateEligible(gate.assessments[index], gate.windowSensitivity) && (
				!sourceReconciliation || Boolean(item.pendingProposalId && affectedPendingProposalIds.includes(item.pendingProposalId)
					&& item.candidate.source_message_ids.some(id => batch.reconciliationSourceIds.has(id)))
			));
			const candidateAssessments = reconciledTasks.map(({ candidate: task }, index) => ({
				...gate.assessments[index],
				automaticEligibility: automaticCandidateEligible(gate.assessments[index], gate.windowSensitivity) ? "eligible" : "ineligible",
				proposedAction: task.proposed_action,
				sourceMessageIds: task.source_message_ids,
			}));
			let pipelineLatencyMs = contextSelection.latencyMs + extraction.latencyMs + reconciliation.latencyMs + gate.latencyMs;
			let pipelineUsage = combinedUsage(contextSelection.usage, extraction.usage, reconciliation.usage, gate.usage);
			for (const { candidate: task, pendingProposalId } of eligibleTasks) {
				const inferredAssigneeId = task.assignee_alias ? reverse.get(task.assignee_alias) : undefined;
				const inferredAccountableId = source.find(message => task.source_message_ids.includes(message.id))?.author.id;
				const [assigneeResolution, accountableResolution] = await Promise.all([
					resolveOptionalOwner(inferredAssigneeId, "assignee", primary.guild!, services),
					resolveOptionalOwner(inferredAccountableId, "accountable user", primary.guild!, services),
				]);
				const assigneeId = assigneeResolution.discordId;
				const accountableId = accountableResolution.discordId;
				const identityAmbiguities = [assigneeResolution.ambiguity, accountableResolution.ambiguity].filter((value): value is string => Boolean(value));
				const ambiguities = [...result.ambiguities, ...identityAmbiguities];
				const assignee = inferredAssigneeId ? await primary.guild!.members.fetch(inferredAssigneeId).catch(() => null) : null;
				let projectId = await resolveProjectId(primary.channelId, primary.guild!, projects, {
					teamProjectId: projectIdForTeamRoles(assignee, services.config.teamRoles),
					inferredProjectName: task.project_name,
				});
				const accountableName = accountableId ? source.find(message => message.author.id === accountableId)?.member?.displayName
					?? source.find(message => message.author.id === accountableId)?.author.username : undefined;
				const ownerText = proposalOwnerText(assigneeId ? assignee?.displayName ?? assignee?.user.username : undefined, accountableName);
				let priority = task.priority_name ? priorities.find(item => item.name.toLocaleLowerCase() === task.priority_name!.toLocaleLowerCase()) : undefined;
				let estimatedHours = task.estimated_hours ?? undefined;
				const sourceLinks = task.source_message_ids.map(id => `https://discord.com/channels/${primary.guildId}/${source.find(item => item.id === id)?.channelId ?? channelId}/${id}`);
				const description = formatAiTaskDescription(task.description, minimized, sourceRecords, task.source_message_ids, task.relevant_attachment_ids);
				const sourceAttachments = relevantImageAttachments(sourceRecords, task.source_message_ids, task.relevant_attachment_ids);
				const ragAssessment = projectId && services.rag
					? await services.rag.assessSimilar(projectId, task.title, description, task.proposed_action)
					: { candidates: [], recommendedMatch: undefined, latencyMs: 0, usage: undefined, telemetry: { outcome: "disabled" } };
				pipelineLatencyMs += ragAssessment.latencyMs;
				pipelineUsage = combinedUsage(pipelineUsage, ragAssessment.usage);
				ragEvaluations.push({
					title: task.title, proposedAction: task.proposed_action, ...ragAssessment.telemetry,
				});
				const suggestedMatch = services.config.OPENPROJECT_RAG_MODE === "review" ? ragAssessment.recommendedMatch : undefined;
				const ragCandidates = services.config.OPENPROJECT_RAG_MODE === "review" ? ragAssessment.candidates : [];
				const sourceLinkedTargets = await services.db.trackedWorkPackagesForSourceMessages(task.source_message_ids);
				const targetResolution = await resolveProposalTarget({
					action: task.proposed_action,
					sourceTexts: task.source_message_ids.map(id => sourceRecords.get(id)?.text ?? ""),
					openProjectBaseUrl: services.config.OPENPROJECT_BASE_URL,
					projectId,
					ragMode: services.config.OPENPROJECT_RAG_MODE,
					suggestedMatch,
					sourceLinkedTargetId: sourceLinkedTargets.length === 1 ? sourceLinkedTargets[0].work_package_id : undefined,
					workPackage: id => services.openProject.workPackage(id),
				});
				projectId = targetResolution.projectId;
				const { action, match, target } = targetResolution;
				const candidateSizes = projectId === channelProjectId ? sizes : projectId ? await services.openProject.sizeOptions(projectId) : [];
				let size = task.size_name ? candidateSizes.find(item => item.value.toLocaleLowerCase() === task.size_name!.toLocaleLowerCase()) : undefined;
				const metadataInference = { priority: priority === undefined, size: size === undefined, estimate: estimatedHours === undefined };
				if (action !== "create" && !match) {
					const provisional = planExistingTaskOperations({
						workPackage: { description: "Existing task" }, requestedAction: action, contentIntent: "none", description: "",
						metadataFields: task.metadata_change_fields,
						values: { title: task.title, assigneeDiscordId: assigneeId, priorityId: priority?.id,
							sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined, startDate: task.start_date ?? undefined,
							dueDate: task.due_date ?? undefined, estimatedHours },
					});
					const contentOperation = task.content_intent === "update_note" ? "postComment" : task.content_intent === "replace_description" ? "descriptionReplacement" : "none";
					if (services.config.OPENPROJECT_AUTOMATION_MODE === "shadow" && !sourceReconciliation) {
						createdProposals++;
						continue;
					}
					const reviewers = new Set(source.filter(message => task.source_message_ids.includes(message.id)).map(message => message.author.id));
					const proposal = await services.db.createProposal({
						preferredProposalId: pendingProposalId, permittedExistingProposalIds, channelId, projectId,
						title: task.title, description, assigneeDiscordId: assigneeId, accountableDiscordId: accountableId,
						priorityId: priority?.id, sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined,
						startDate: task.start_date ?? undefined, dueDate: task.due_date ?? undefined,
						estimatedHours, metadataInference,
						sourceMessageIds: task.source_message_ids, sourceLinks, sourceAttachments, ragCandidates,
						modelDeployment: deployment, permittedReviewerIds: [...reviewers], evidence: task.evidence,
						ambiguities: [...ambiguities, "Target OpenProject task must be selected before applying."],
						latencyMs: pipelineLatencyMs, tokenUsage: pipelineUsage, action,
						metadataPatch: provisional.metadataPatch, contentOperation, contentMarkdown: contentOperation === "none" ? null : description,
						workItemKey: task.work_item_key, sourceContentHash: sourceContentHash(task.source_message_ids.map(id => ({ id, text: sourceRecords.get(id)?.text ?? "", attachments: sourceRecords.get(id)?.attachments }))),
						retentionDays: services.config.OPENPROJECT_PROPOSAL_RETENTION_DAYS,
					});
					proposalIds.add(proposal.id);
					const stored = await services.db.proposal(proposal.id);
					if (stored) {
						const reviewPayload: ReviewCardPayload = {
							content: boundedDiscordContent(`Target required for proposed ${action}: **${task.title}**\n${description}`),
							components: proposalReviewComponents(proposal.id, action, ragCandidates, false), allowedMentions: { parse: [] },
						};
						if (proposal.revised) await updateStoredReviewCard(primary, services, proposal.id, reviewPayload);
						else if (services.config.OPENPROJECT_AUTOMATION_MODE === "review" && primary.channel.isSendable()) {
							const reviewMessage = await primary.channel.send(reviewPayload);
							await services.db.setProposalReviewMessage(proposal.id, reviewMessage.id);
						}
					}
					createdProposals++;
					continue;
				}
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
						requestedAction: action,
						contentIntent: sourceLinkedTargets.length === 1 && task.proposed_action === "create" && task.content_intent === "none" ? "update_note" : task.content_intent,
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
					if (services.config.OPENPROJECT_AUTOMATION_MODE === "shadow" && seenCandidates.some(seen => seen.action === action && seen.projectId === projectId && seen.targetWorkPackageId === match.workPackageId && seen.assigneeId === assigneeId && titlesLikelyDuplicate(seen.title, task.title))) {
						duplicates++;
						continue;
					}
					if (services.config.OPENPROJECT_AUTOMATION_MODE === "shadow" && !sourceReconciliation) {
						seenCandidates.push({ title: task.title, action, projectId, targetWorkPackageId: match.workPackageId, assigneeId });
						createdProposals++;
						continue;
					}
					const reviewers = new Set<string>(source.filter(message => task.source_message_ids.includes(message.id)).map(message => message.author.id));
					if (assigneeId) reviewers.add(assigneeId);
					if (accountableId) reviewers.add(accountableId);
					for (const reviewer of [...reviewers]) if (!await services.db.openProjectUserId(reviewer)) reviewers.delete(reviewer);
					const proposal = await services.db.createProposal({
						preferredProposalId: pendingProposalId,
						permittedExistingProposalIds,
						channelId, projectId, title: task.title, description, assigneeDiscordId: assigneeId, accountableDiscordId: accountableId,
						priorityId: priority?.id, sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined,
						startDate: task.start_date ?? undefined, dueDate, estimatedHours, metadataInference,
						sourceMessageIds: task.source_message_ids, sourceLinks,
						sourceAttachments,
						ragCandidates,
						modelDeployment: deployment, permittedReviewerIds: [...reviewers], evidence: task.evidence,
						ambiguities: [...ambiguities, `Possible existing task match: ${match.workPackageId}`], latencyMs: pipelineLatencyMs, tokenUsage: pipelineUsage,
						action, targetWorkPackageId: match.workPackageId, targetLockVersion: target!.lockVersion,
						metadataPatch: operations.metadataPatch, contentOperation: operations.contentOperation,
						contentMarkdown: operations.contentMarkdown,
						workItemKey: task.work_item_key,
						sourceContentHash: sourceContentHash(task.source_message_ids.map(id => ({
							id, text: sourceRecords.get(id)?.text ?? "", attachments: sourceRecords.get(id)?.attachments,
						}))),
						initialSnapshot: {
							title: task.title, description, projectId, assigneeId, accountableId, priorityId: priority?.id,
							sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined, startDate: task.start_date,
							dueDate, estimatedHours: estimatedHours ?? null, action, targetWorkPackageId: match.workPackageId,
							sourceMessageIds: task.source_message_ids, sourceLinks,
						},
						retentionDays: services.config.OPENPROJECT_PROPOSAL_RETENTION_DAYS,
					});
					const reviewPayload: ReviewCardPayload = {
						content: proposalReviewCardContent(`${ownerText}Proposed ${action} for OpenProject task ${workPackageMarkdownLink(target!.id, target!.subject, services.openProject.workPackageUrl(target!.id))}\nProposed title: **${task.title}**\n${describeProposalOperations(operations.contentOperation, operations.metadataPatch, { assignee: assigneeId ? assignee?.displayName ?? assignee?.user.username : undefined, priority: priority?.name, size: size?.value }).map(item => `- ${item}`).join("\n")}${operations.contentOperation === "descriptionReplacement" ? "\nThis will replace the canonical task description." : ""}${formatProposalContent(operations.contentOperation, operations.contentMarkdown)}${ambiguities.length ? `\n\nAmbiguities: ${ambiguities.join("; ")}` : ""}`),
						components: proposalReviewComponents(proposal.id, action, ragCandidates, true),
						allowedMentions: { parse: [] },
					};
					proposalIds.add(proposal.id);
					if (proposal.reused) {
						if (proposal.revised && await updateStoredReviewCard(primary, services, proposal.id, reviewPayload)) revisedProposals++;
						else duplicates++;
						continue;
					}
					seenCandidates.push({ title: task.title, action, projectId, targetWorkPackageId: match.workPackageId, assigneeId });
					if (services.config.OPENPROJECT_AUTOMATION_MODE === "review") {
						const channel = primary.channel;
						if (channel?.isSendable()) try {
							const reviewMessage = await channel.send(reviewPayload);
							if (!await services.db.setProposalReviewMessage(proposal.id, reviewMessage.id)) {
								await reviewMessage.delete().catch(() => undefined);
								throw new Error("The proposal was handled before its review card could be attached.");
							}
						} catch (error) {
							await services.db.markProposalDeliveryFailed(proposal.id, (error as Error).message);
							throw error;
						}
					}
					createdProposals++;
					continue;
				}
				const advisory = ragCandidates.length
					? `${ragCandidates.length} existing OpenProject ${ragCandidates.length === 1 ? "task may" : "tasks may"} track the same or related work. Select one below, or choose Review new task to keep this as new work.`
					: undefined;
				const citedIds = new Set(task.source_message_ids);
				const reviewers = new Set<string>(source.filter(message => citedIds.has(message.id)).map(message => message.author.id));
				if (assigneeId) reviewers.add(assigneeId);
				if (accountableId) reviewers.add(accountableId);
				for (const reviewer of [...reviewers]) {
					if (!await services.db.openProjectUserId(reviewer)) reviewers.delete(reviewer);
				}
				if (services.config.OPENPROJECT_AUTOMATION_MODE === "shadow" && seenCandidates.some(seen => seen.action === action && seen.projectId === projectId && seen.targetWorkPackageId === undefined && seen.assigneeId === assigneeId && titlesLikelyDuplicate(seen.title, task.title))) {
					duplicates++;
					continue;
				}
				if (services.config.OPENPROJECT_AUTOMATION_MODE === "shadow" && !sourceReconciliation) {
					seenCandidates.push({ title: task.title, action, projectId, assigneeId });
					createdProposals++;
					continue;
				}
				const proposal = await services.db.createProposal({
					preferredProposalId: pendingProposalId,
					permittedExistingProposalIds,
					channelId, projectId, title: task.title,
						description, assigneeDiscordId: assigneeId, accountableDiscordId: accountableId,
						priorityId: priority?.id, sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined,
						startDate: task.start_date ?? undefined, dueDate, estimatedHours, metadataInference,
						sourceMessageIds: task.source_message_ids, sourceLinks,
						sourceAttachments,
					modelDeployment: deployment,
					permittedReviewerIds: [...reviewers],
					evidence: task.evidence, ambiguities: [...ambiguities, ...(advisory ? [advisory] : [])],
					latencyMs: pipelineLatencyMs, tokenUsage: pipelineUsage,
						escalationReason: extraction.escalationReason,
						workItemKey: task.work_item_key,
						sourceContentHash: sourceContentHash(task.source_message_ids.map(id => ({
							id, text: sourceRecords.get(id)?.text ?? "", attachments: sourceRecords.get(id)?.attachments,
						}))),
						initialSnapshot: {
							title: task.title, description, projectId, assigneeId, accountableId, priorityId: priority?.id,
							sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined, startDate: task.start_date,
							dueDate, estimatedHours: estimatedHours ?? null, action: "create",
							sourceMessageIds: task.source_message_ids, sourceLinks,
						},
						retentionDays: services.config.OPENPROJECT_PROPOSAL_RETENTION_DAYS,
						ragCandidates,
				});
				const reviewPayload: ReviewCardPayload = {
					content: proposalReviewCardContent(`${ownerText}Proposed OpenProject task: **${task.title}**\n${description}\n\nProject: ${projects.find(item => item.id === projectId)?.name ?? "Not resolved"}\nPriority: ${priority?.name ?? "Not inferred"}\nSize: ${size?.value ?? "Not inferred"}\nDates: ${task.start_date ?? "Not set"} → ${dueDate}\nEstimate: ${estimatedHours !== undefined ? `${estimatedHours}h` : "Not inferred"}${advisory ? `\n\n${advisory}` : ""}${ambiguities.length ? `\n\nAmbiguities: ${ambiguities.join("; ")}` : ""}`),
					components: proposalReviewComponents(proposal.id, "create", ragCandidates),
					allowedMentions: { parse: [] },
				};
				proposalIds.add(proposal.id);
				if (proposal.reused) {
					if (proposal.revised && await updateStoredReviewCard(primary, services, proposal.id, reviewPayload)) revisedProposals++;
					else duplicates++;
					continue;
				}
				seenCandidates.push({ title: task.title, action, projectId, assigneeId });
				createdProposals++;
				if (services.config.OPENPROJECT_AUTOMATION_MODE === "review") {
					const channel = primary.channel;
					if (channel?.isSendable()) {
						try {
						const reviewMessage = await channel.send(reviewPayload);
						if (!await services.db.setProposalReviewMessage(proposal.id, reviewMessage.id)) {
							await reviewMessage.delete().catch(() => undefined);
							throw new Error("The proposal was handled before its review card could be attached.");
						}
						} catch (error) {
							await services.db.markProposalDeliveryFailed(proposal.id, (error as Error).message);
							throw error;
						}
					}
				}
			}
			if (services.config.OPENPROJECT_AUTOMATION_MODE !== "shadow" || sourceReconciliation) {
				const supersededIds = reconciledSupersessionIds({
					reconciledCount: reconciledTasks.length, eligibleCount: eligibleTasks.length, extractedCount: result.tasks.length,
					reconciliationSucceeded, persistedProposalIds: proposalIds,
					recommendedSupersessionIds: reconciliation.supersededPendingProposalIds,
					invalidatableProposalIds: invalidatablePendingProposalIds,
				});
				const superseded = proposalIds.size > 0 && supersededIds.length
					? await services.db.mergeAndSupersedePendingProposals([...proposalIds][0]!, supersededIds)
					: await services.db.supersedePendingProposals(supersededIds);
				for (const proposal of superseded) {
					if (!proposal.review_message_id) continue;
					const reviewChannel = await primary.client.channels.fetch(proposal.channel_id).catch(() => null);
					if (!reviewChannel?.isTextBased() || !("messages" in reviewChannel)) continue;
					const reviewMessage = await reviewChannel.messages.fetch(proposal.review_message_id).catch(() => null);
					if (reviewMessage) await reviewMessage.edit({ content: "This proposal is no longer active after the source discussion was reconciled.", components: [] }).catch(() => undefined);
				}
			}
			await services.db.recordExtraction({
				source: "automatic",
				outcome: createdProposals || revisedProposals ? "proposal" : duplicates ? "duplicate" : "no_task",
				modelDeployment: deployment,
				 taskCount: result.tasks.length,
				latencyMs: pipelineLatencyMs,
				tokenUsage: pipelineUsage,
				triggerId: primary.id,
				inputSnapshot: extraction.inputMessages.map(({ containedSensitiveData: _, ...message }) => message),
				messageAssessments: candidateAssessments,
				proposalIds: [...proposalIds],
				decision: {
					taskCount: result.tasks.length,
					groundedCount: individuallyGroundedTasks.length,
					groupedCount: groupedTasks.length,
					reconciledCount: reconciledTasks.length,
					eligibleCount: eligibleTasks.length,
					rejectedCount: reconciledTasks.length - eligibleTasks.length,
					invalidGroundingCount: result.tasks.length - individuallyGroundedTasks.length,
					extractionMetadata: extraction.metadata,
					extractionOptions: extraction.replayOptions,
					windowSensitivity: gate.windowSensitivity,
					pipelineVersion: "v5",
					extractionPromptVersion: "candidate-v4",
					gatePromptVersion: "automatic-precision-v1",
					stages: {
						contextSelection: { deployment: contextSelection.deployment, latencyMs: contextSelection.latencyMs, candidateMessageCount: minimizedCandidates.length, selectedMessageCount: minimized.length },
						extraction: { deployment: extraction.deployment, latencyMs: extraction.latencyMs, tokenUsage: extraction.usage },
						proposalReconciliation: { deployment: reconciliation.deployment, latencyMs: reconciliation.latencyMs, pendingProposalCount: pendingProposals.length },
						precisionGate: { deployment: gate.deployment, latencyMs: gate.latencyMs, tokenUsage: gate.usage },
					},
					proposalCount: createdProposals,
					duplicateCount: duplicates,
					revisedProposalCount: revisedProposals,
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
					: { errorType: !diagnostics || diagnostics.stage === "processing" ? "processing_error" : error instanceof StructuredOutputError ? "invalid_output" : "provider_error", stage: diagnostics?.stage, extractionMetadata: diagnostics?.metadata, extractionOptions: diagnostics?.replayOptions, gateInvoked: Boolean(completedGate) },
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

	const enqueueMessage = async (message: Message, reconciliationSourceId?: string) => {
		if (!message.inGuild() || !isOrganizerGuild(services.config, message.guildId) || message.author.bot || message.system) return;
		if (await isExcludedChannel(message.channelId, message.guild!, services.config.excludedChannelIds)) return;
		const existing = batches.get(message.channelId);
		if (existing) clearTimeout(existing.timer);
		const messages = [...(existing?.messages ?? []).filter(item => item.id !== message.id), message]
			.sort((left, right) => left.createdTimestamp - right.createdTimestamp)
			.slice(-30);
		const timer = setTimeout(() => enqueueFlush(message.channelId), services.config.OPENPROJECT_BATCH_IDLE_SECONDS * 1000);
		batches.set(message.channelId, {
			messages,
			reconciliationSourceIds: new Set([...(existing?.reconciliationSourceIds ?? []), ...(reconciliationSourceId ? [reconciliationSourceId] : [])]),
			timer,
		});
	};
	client.on("messageCreate", message => {
		if (services.config.OPENPROJECT_AUTOMATION_MODE === "off" || !services.extractor.enabled) return;
		void enqueueMessage(message).catch(error => console.error("Automatic task message enqueue failed", { channelId: message.channelId, error: (error as Error).message }));
	});
	client.on("messageUpdate", (previous, updated) => {
		void (async () => {
			const message = updated.partial ? await updated.fetch().catch(() => null) : updated;
			if (!message) return;
			const previousAttachments = previous.partial ? "" : [...previous.attachments.values()].map(attachment => `${attachment.id}:${attachment.url}`).join("|");
			const currentAttachments = [...message.attachments.values()].map(attachment => `${attachment.id}:${attachment.url}`).join("|");
			if (!messageRevisionChanged(previous.partial ? undefined : previous.content, message.content, previousAttachments, currentAttachments)) return;
			const affected = await services.db.pendingProposalsForSourceMessage(message.id);
			if (!sourceEditShouldReconcile(services.config.OPENPROJECT_AUTOMATION_MODE, affected)) return;
			await enqueueMessage(message, affected.length ? message.id : undefined);
		})().catch(error => console.error("Automatic task message update enqueue failed", { channelId: updated.channelId, error: (error as Error).message }));
	});
	client.on("messageDelete", message => {
		void (async () => {
			const superseded = await services.db.supersedePendingProposalsForDeletedSource(message.id);
			for (const proposal of superseded) {
				if (!proposal.review_message_id) continue;
				const channel = await client.channels.fetch(proposal.channel_id).catch(() => null);
				if (channel?.isTextBased() && "messages" in channel) {
					const card = await channel.messages.fetch(proposal.review_message_id).catch(() => null);
					if (card) await card.edit({ content: "This proposal was superseded because a cited source message was deleted.", components: [] }).catch(() => undefined);
				}
				await services.db.clearProposalReviewMessage(proposal.id, proposal.review_message_id);
			}
		})().catch(error => console.error("Deleted task source reconciliation failed", { messageId: message.id, error: (error as Error).message }));
	});
	console.log(`Automatic task source maintenance enabled; new extraction mode is ${services.config.OPENPROJECT_AUTOMATION_MODE}`);
}
