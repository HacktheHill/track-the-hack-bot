import {
	ApplicationCommandType,
	AutocompleteInteraction,
	ChatInputCommandInteraction,
	Client,
	ContextMenuCommandBuilder,
	GuildMember,
	Guild,
	MessageContextMenuCommandInteraction,
	ModalBuilder,
	ModalSubmitInteraction,
	SlashCommandBuilder,
	TextInputBuilder,
	TextInputStyle,
	ActionRowBuilder,
	ChannelType,
	ButtonBuilder,
	ButtonStyle,
	ButtonInteraction,
	Message,
	MessageFlags,
	PermissionFlagsBits,
	StringSelectMenuBuilder,
	UserSelectMenuBuilder,
	StringSelectMenuInteraction,
	UserSelectMenuInteraction,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { isOrganizerGuild, type IntegrationConfig, type TeamMapping } from "./config.js";
import { correctionFields, Database, type CorrectionFlags, type ProposalMetrics } from "./database.js";
import { OpenProjectClient, OpenProjectRequestError } from "./openproject.js";
import { containsSensitiveContent, minimizeText, normalizeExtractedDate, sanitizeGeneratedDescription, SensitiveContentError, StructuredOutputError, type MinimizedMessage, type TaskExtractor } from "./azure-openai.js";
import { resolveProposedAction, type OpenProjectRag } from "./rag.js";

export const taskCommand = new SlashCommandBuilder()
	.setName("task")
	.setDescription("Create an OpenProject task")
	.addSubcommand(command =>
		command
			.setName("create")
			.setDescription("Create a task")
			.addStringOption(option =>
				option.setName("title").setDescription("Task title").setRequired(true).setMaxLength(255),
			)
			.addStringOption(option =>
				option.setName("description").setDescription("Task description (optional)").setMaxLength(2000),
			)
			.addStringOption(option =>
				option.setName("project").setDescription("OpenProject project").setAutocomplete(true),
			)
			.addUserOption(option => option.setName("assignee").setDescription("Discord assignee"))
			.addUserOption(option => option.setName("accountable").setDescription("Override the accountable Discord user"))
			.addStringOption(option =>
				option
					.setName("priority")
					.setDescription("Priority")
					.setAutocomplete(true),
			)
			.addStringOption(option =>
				option.setName("size").setDescription("Task size").setAutocomplete(true),
			)
			.addStringOption(option => option.setName("start_date").setDescription("Start date").setAutocomplete(true))
			.addStringOption(option => option.setName("due_date").setDescription("Due date").setAutocomplete(true))
			.addNumberOption(option => option.setName("estimated_hours").setDescription("Estimated work in hours").setMinValue(0))
			.addStringOption(option => option.setName("source_message").setDescription("Discord message link"))
			.addBooleanOption(option => option.setName("allow_duplicate").setDescription("Create even if a similar open task exists")),
	)
	.addSubcommand(command => command.setName("view").setDescription("Show a task summary and OpenProject link")
		.addIntegerOption(option => option.setName("id").setDescription("OpenProject task ID").setRequired(true).setMinValue(1)))
	.addSubcommand(command => command.setName("assign").setDescription("Assign an existing task")
		.addIntegerOption(option => option.setName("id").setDescription("OpenProject task ID").setRequired(true).setMinValue(1))
		.addUserOption(option => option.setName("assignee").setDescription("Discord assignee").setRequired(true)))
	.addSubcommand(command => command.setName("reschedule").setDescription("Change task dates")
		.addIntegerOption(option => option.setName("id").setDescription("OpenProject task ID").setRequired(true).setMinValue(1))
		.addStringOption(option => option.setName("start_date").setDescription("Start date YYYY-MM-DD, or clear"))
		.addStringOption(option => option.setName("due_date").setDescription("Due date YYYY-MM-DD, or clear")))
	.addSubcommand(command => command.setName("close").setDescription("Close an existing task")
		.addIntegerOption(option => option.setName("id").setDescription("OpenProject task ID").setRequired(true).setMinValue(1)))
	.addSubcommand(command => command.setName("reopen").setDescription("Reopen an existing task")
		.addIntegerOption(option => option.setName("id").setDescription("OpenProject task ID").setRequired(true).setMinValue(1)))
	.addSubcommand(command => command.setName("reconcile").setDescription("Reconcile an ambiguous task creation")
		.addStringOption(option => option.setName("proposal").setDescription("Creation or proposal UUID").setRequired(true))
		.addIntegerOption(option => option.setName("work_package_id").setDescription("OpenProject work package ID").setRequired(true).setMinValue(1)))
	.addSubcommand(command => command.setName("announce").setDescription("Retry a Discord task announcement")
		.addIntegerOption(option => option.setName("id").setDescription("OpenProject task ID").setRequired(true).setMinValue(1))
		.addUserOption(option => option.setName("assignee").setDescription("Optional user to ping")))
	.addSubcommand(command => command.setName("metrics").setDescription("Show AI proposal quality metrics")
		.addIntegerOption(option => option.setName("period").setDescription("Reporting period").setRequired(true)
			.addChoices(
				{ name: "Last 7 days", value: 7 },
				{ name: "Last 30 days", value: 30 },
				{ name: "Last 90 days", value: 90 },
			)))
	.addSubcommand(command => command.setName("extract").setDescription("Force AI extraction from recent channel messages")
		.addIntegerOption(option => option.setName("message_count").setDescription("Number of recent messages to inspect").setMinValue(1).setMaxValue(50)))
	.addSubcommand(command => command.setName("link-user").setDescription("Map a Discord user to an OpenProject user")
		.addUserOption(option => option.setName("discord_user").setDescription("Discord user").setRequired(true))
		.addStringOption(option => option.setName("openproject_user").setDescription("OpenProject user").setRequired(true).setAutocomplete(true)))
	.addSubcommand(command => command.setName("configure-category").setDescription("Set a category's default OpenProject project")
		.addChannelOption(option => option.setName("category").setDescription("Discord category").addChannelTypes(ChannelType.GuildCategory).setRequired(true))
		.addStringOption(option => option.setName("project").setDescription("OpenProject project").setRequired(true).setAutocomplete(true)),
	);

export const taskMessageCommand = new ContextMenuCommandBuilder()
	.setName("Create OpenProject task")
	.setType(ApplicationCommandType.Message);

export const aiTaskMessageCommand = new ContextMenuCommandBuilder()
	.setName("Draft OpenProject task with AI")
	.setType(ApplicationCommandType.Message);

type Services = { config: IntegrationConfig; db: Database; openProject: OpenProjectClient; extractor: TaskExtractor; rag?: OpenProjectRag };
type TaskInteraction = ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction;
type ContextDraft = {
	userId: string; channelId: string; targetId: string; title: string; description: string;
	projectId?: number; assigneeId?: string; expiresAt: number;
};
type CreationDraft = {
	userId: string; channelId: string; expiresAt: number; proposalId?: string;
	title: string; description: string; projectText: string | null;
	assigneeId?: string; accountableId?: string; priorityId?: number; sizeHref?: string;
	startDate?: string; dueDate?: string; estimatedHours?: number;
	sourceLinks: string[]; allowDuplicate?: boolean;
};
type CollectedContext = {
	messages: MinimizedMessage[];
	sourceRecords: Map<string, { author: string; timestamp: string; text: string; attachments: Array<{ id: string; name: string; contentType?: string; url: string }> }>;
	reverseAliases: Map<string, string>;
	validIds: Set<string>;
	focusIds: Set<string>;
	primaryId: string;
	primaryAuthorId: string;
	explicitAssigneeId?: string;
};
const sensitiveOverrides = new Map<string, { userId: string; context: CollectedContext; expiresAt: number }>();

function normalizedMetricValue(value?: string | null) {
	return (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function proposalCorrections(input: {
	original: {
		title: string; description: string; projectName?: string; assigneeId?: string | null;
		accountableId?: string | null; priorityId?: number | null; sizeHref?: string | null;
		startDate?: string | null; dueDate?: string | null; estimatedHours?: number | null;
	};
	reviewed: {
		title: string; description: string; projectName?: string; assigneeId?: string;
		accountableId?: string; priorityId?: number; sizeHref?: string;
		startDate?: string; dueDate?: string; estimatedHours?: number;
	};
}): CorrectionFlags {
	const { original, reviewed } = input;
	return {
		title: normalizedMetricValue(original.title) !== normalizedMetricValue(reviewed.title),
		description: normalizedMetricValue(original.description) !== normalizedMetricValue(reviewed.description),
		project: normalizedMetricValue(original.projectName) !== normalizedMetricValue(reviewed.projectName),
		assignee: (original.assigneeId ?? undefined) !== reviewed.assigneeId,
		accountable: (original.accountableId ?? undefined) !== reviewed.accountableId,
		priority: (original.priorityId ?? undefined) !== reviewed.priorityId,
		size: (original.sizeHref ?? undefined) !== reviewed.sizeHref,
		startDate: (databaseDate(original.startDate) ?? undefined) !== reviewed.startDate,
		dueDate: (databaseDate(original.dueDate) ?? undefined) !== reviewed.dueDate,
		estimate: (original.estimatedHours == null ? undefined : Number(original.estimatedHours)) !== reviewed.estimatedHours,
	};
}

function percent(value: number) {
	return `${Math.round(value * 100)}%`;
}

export function formatProposalMetrics(metrics: ProposalMetrics) {
	const edits = correctionFields.map(field => `${field}: ${percent(metrics.correctionRates[field])}`).join(" · ");
	return [
		`**AI task quality · last ${metrics.days} days**`,
		`Proposals: ${metrics.proposals} · approved: ${metrics.approved} · dismissed: ${metrics.dismissed} · duplicates: ${metrics.duplicates} · failures: ${metrics.failures}`,
		`Approval rate: ${percent(metrics.approvalRate)} · duplicate rate: ${percent(metrics.duplicateRate)} · reconciliations: ${metrics.reconciliations}`,
		`Assignee accepted: ${percent(metrics.assigneeAcceptanceRate)} · deadline accepted: ${percent(metrics.deadlineAcceptanceRate)}`,
		`Average review: ${Math.round(metrics.averageReviewDurationMs / 1000)}s · extraction: ${Math.round(metrics.averageExtractionLatencyMs)}ms · tokens: ${metrics.totalTokens} · invalid outputs: ${metrics.invalidOutputs}`,
		`Field edit rates — ${edits}`,
	].join("\n");
}

export function boundedDiscordContent(value: string, limit = 2000) {
	if (value.length <= limit) return value;
	return `${value.slice(0, Math.max(0, limit - 24)).trimEnd()}\n\n[Preview truncated]`;
}

function proposalSnapshot(input: {
	title: string; description: string; projectId?: number | null; assigneeId?: string | null;
	accountableId?: string | null; priorityId?: number | null; sizeHref?: string | null;
	startDate?: string | null; dueDate?: string | null; estimatedHours?: number | null;
	action: string; targetWorkPackageId?: number | null; sourceMessageIds?: string[]; sourceLinks?: string[];
}) {
	return input;
}

async function deliverProposalReply(
	interaction: MessageContextMenuCommandInteraction | ChatInputCommandInteraction | ButtonInteraction,
	services: Services,
	proposalId: string,
	payload: Parameters<typeof interaction.editReply>[0],
) {
	try {
		await interaction.editReply(payload);
	} catch (error) {
		await services.db.markProposalDeliveryFailed(proposalId, (error as Error).message);
		throw error;
	}
}

async function contextDraft(id: string, userId: string, services: Services) {
	return services.db.draft<ContextDraft>(id, userId, "context");
}

async function creationDraft(id: string, userId: string, services: Services) {
	return services.db.draft<CreationDraft>(id, userId, "creation");
}

function messageUrl(guildId: string, channelId: string, messageId: string) {
	return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

async function validatedSourceLink(value: string | null, interaction: ChatInputCommandInteraction) {
	if (!value) return [];
	const match = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)$/.exec(value.trim());
	if (!match || match[1] !== interaction.guildId) throw new Error("source_message must be a Discord message link from this server.");
	const channel = await interaction.guild!.channels.fetch(match[2]);
	if (!channel?.isTextBased() || !("messages" in channel)) throw new Error("The source message channel is not accessible.");
	await channel.messages.fetch(match[3]).catch(() => { throw new Error("The source message no longer exists or is inaccessible."); });
	return [messageUrl(match[1], match[2], match[3])];
}

export function validIsoDate(value?: string | null) {
	if (!value) return undefined;
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	const parsed = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
	if (!match || !parsed || parsed.toISOString().slice(0, 10) !== value) {
		throw new Error("Dates must use YYYY-MM-DD.");
	}
	return value;
}

export function calendarDate(now: Date, timeZone = "America/Toronto") {
	const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
		timeZone, year: "numeric", month: "2-digit", day: "2-digit",
	}).formatToParts(now).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
	return `${parts.year}-${parts.month}-${parts.day}`;
}

function addCalendarDays(value: string, days: number) {
	const date = new Date(`${value}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

export function defaultTaskDates(now: Date, startToday: boolean, dueDays: number, timeZone = "America/Toronto") {
	const start = calendarDate(now, timeZone);
	return {
		startDate: startToday ? start : undefined,
		dueDate: addCalendarDays(start, dueDays),
	};
}

export function defaultAiDueDate(now: Date, priorityName?: string, sizeName?: string, timeZone = "America/Toronto") {
	const priorityDays = priorityName?.toLocaleLowerCase() === "immediate" ? 3
		: priorityName?.toLocaleLowerCase() === "high" ? 7
			: priorityName?.toLocaleLowerCase() === "low" ? 21 : 14;
	const normalizedSize = (sizeName ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
	const sizeDays = normalizedSize.includes("x large") ? 28
		: normalizedSize.includes("large") ? 14
			: normalizedSize.includes("medium") ? 7 : 0;
	return addCalendarDays(calendarDate(now, timeZone), priorityDays + sizeDays);
}

export function explicitAssignmentNames(text: string) {
	const names = new Set<string>();
	for (const match of text.matchAll(/\bTask\s*\d+\s*\(([^)\n]{2,64})\)/gi)) names.add(match[1].trim());
	for (const match of text.matchAll(/\b(?:assignee|assigned to|owner)\s*[:=-]?\s*([^\n,;]{2,64})/gi)) names.add(match[1].trim());
	return [...names];
}

function validateDateOrder(startDate?: string | null, dueDate?: string | null) {
	if (startDate && dueDate && startDate > dueDate) throw new Error("The start date cannot be after the due date.");
}

export function dateChoices(query: string, includePast = false, now = new Date(), timeZone = "America/Toronto") {
	const today = calendarDate(now, timeZone);
	const offsets = includePast
		? [0, ...Array.from({ length: 30 }, (_, index) => index + 1).flatMap(offset => [-offset, offset])]
		: Array.from({ length: 31 }, (_, offset) => offset);
	const choices = offsets.map(offset => {
		const value = addCalendarDays(today, offset);
		const label = offset === 0 ? `Today — ${value}`
			: offset === 1 ? `Tomorrow — ${value}`
				: offset === -1 ? `Yesterday — ${value}` : value;
		return { name: label, value };
	});
	return choices.filter(choice => choice.value.includes(query) || choice.name.toLowerCase().includes(query.toLowerCase()));
}

function matchedTeam(member: GuildMember | null, mappings: Record<string, TeamMapping>) {
	if (!member) return undefined;
	return Object.entries(mappings)
		.filter(([role]) => member.roles.cache.has(role))
		.sort(([, a], [, b]) => (a.priority ?? 999) - (b.priority ?? 999))[0];
}

async function accountableFor(
	assignee: GuildMember | null,
	services: Services,
) {
	const executiveRole = services.config.ORGANIZER_GUILD_EXECUTIVE_ROLE_ID;
	const team = matchedTeam(assignee, services.config.teamRoles);
	if (!assignee || !executiveRole || !team) return undefined;
	if (assignee.roles.cache.has(executiveRole)) return undefined;
	if (team[1].accountableDiscordId) {
		const configuredId = await services.db.openProjectUserId(team[1].accountableDiscordId);
		if (configuredId) return { discordId: team[1].accountableDiscordId, openProjectId: configuredId };
	}
	const candidates = assignee.guild.members.cache
		.filter(member => member.roles.cache.has(team[0]) && member.roles.cache.has(executiveRole))
		.sort((left, right) => left.id.localeCompare(right.id));
	for (const candidate of candidates.values()) {
		const id = await services.db.openProjectUserId(candidate.id);
		if (id) return { discordId: candidate.id, openProjectId: id };
	}
	return undefined;
}

async function requireCreator(interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction | ModalSubmitInteraction | ButtonInteraction, services: Services) {
	if (!interaction.inGuild() || !isOrganizerGuild(services.config, interaction.guildId)) {
		throw new Error("OpenProject tasks are available only in the Organizer Discord server.");
	}
	if (await isExcludedChannel(interaction.channelId!, interaction.guild!, services.config.excludedChannelIds)) {
		throw new Error("Task creation and extraction are disabled in this channel or its category.");
	}
	const member = await interaction.guild!.members.fetch(interaction.user.id);
	if (!member.roles.cache.has(services.config.ORGANIZER_GUILD_MEMBER_ROLE_ID)) {
		throw new Error("You need the Members role to create or manage OpenProject tasks.");
	}
	return member;
}

export async function isExcludedChannel(channelId: string, guild: Guild, excludedIds: ReadonlySet<string>) {
	let channel = await guild.channels.fetch(channelId).catch(() => null);
	for (let depth = 0; channel && depth < 5; depth++) {
		if (excludedIds.has(channel.id)) return true;
		if (!channel.parentId) break;
		channel = await guild.channels.fetch(channel.parentId).catch(() => null);
	}
	return false;
}

export function citesExtractionFocus(sourceMessageIds: readonly string[], focusIds: ReadonlySet<string>) {
	return sourceMessageIds.some(id => focusIds.has(id));
}

async function categoryIdFor(channelId: string, guild: Guild) {
	let channel = await guild.channels.fetch(channelId);
	for (let depth = 0; channel && depth < 3; depth++) {
		if (channel.type === ChannelType.GuildCategory) return channel.id;
		if (!channel.parentId) return undefined;
		channel = await guild.channels.fetch(channel.parentId);
	}
	return undefined;
}

async function categoryProject(channelId: string, guild: Guild, services: Services) {
	const categoryId = await categoryIdFor(channelId, guild);
	return categoryId ? await services.db.categoryProject(categoryId) ?? services.config.categoryProjects[categoryId] : undefined;
}

async function allowedProjectIds(channelId: string, member: GuildMember, services: Services) {
	const allowed = new Set<number>();
	const defaultProject = await categoryProject(channelId, member.guild, services);
	if (defaultProject) allowed.add(defaultProject);
	for (const [roleId, mapping] of Object.entries(services.config.teamRoles)) {
		if (member.roles.cache.has(roleId)) allowed.add(mapping.projectId);
	}
	return allowed;
}

async function requireProjectAccess(interaction: TaskInteraction | MessageContextMenuCommandInteraction, projectId: number, services: Services) {
	if (!interaction.inGuild()) throw new Error("Tasks can only be managed in a server.");
	const member = await interaction.guild!.members.fetch(interaction.user.id);
	const allowed = await allowedProjectIds(interaction.channelId!, member, services);
	if (!allowed.has(projectId)) throw new Error("This channel or your team is not authorized for that OpenProject project.");
}

function projectIdFromWorkPackage(task: { _links: Record<string, { href: string }> }) {
	const match = /\/(?:projects|workspaces)\/(\d+)$/.exec(task._links.project?.href ?? "");
	if (!match) throw new Error("Could not determine the task's OpenProject project.");
	return Number(match[1]);
}

function requireOrganizer(interaction: ChatInputCommandInteraction, services: Services) {
	if (!interaction.inGuild() || !isOrganizerGuild(services.config, interaction.guildId) || !interaction.member || !("roles" in interaction.member)) {
		throw new Error("OpenProject configuration is available only in the Organizer Discord server.");
	}
	const member = interaction.member as GuildMember;
	if (!member.roles.cache.has(services.config.ORGANIZER_GUILD_ORGANIZER_ROLE_ID) && !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
		throw new Error("Only organizers can change OpenProject mappings.");
	}
}

async function resolveProject(
	explicit: string | null,
	channelId: string,
	guild: Guild,
	assignee: GuildMember | null,
	services: Services,
) {
	if (explicit) {
		if (/^\d+$/.test(explicit)) return Number(explicit);
		const normalized = explicit.trim().toLocaleLowerCase();
		const matches = (await services.openProject.projects()).filter(project => project.name.toLocaleLowerCase() === normalized);
		if (matches.length === 1) return matches[0].id;
		throw new Error("Select a valid OpenProject project name.");
	}
	const categoryDefault = await categoryProject(channelId, guild, services);
	if (categoryDefault) return categoryDefault;
	return matchedTeam(assignee, services.config.teamRoles)?.[1].projectId;
}

export function databaseDate(value: unknown) {
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	return normalizeExtractedDate(value == null ? null : String(value));
}

async function resolveAssigneeInput(value: string, guild: Guild) {
	const input = value.trim();
	if (!input) return undefined;
	const mention = /^<@!?(\d+)>$/.exec(input);
	if (mention || /^\d+$/.test(input)) return (mention?.[1] ?? input);
	const normalized = input.replace(/^@/, "").toLocaleLowerCase();
	const matches = [...guild.members.cache.values()].filter(member => [
		member.displayName,
		member.displayName.replace(/(?:\s*\[[^\]]+\])+\s*$/g, ""),
		member.user.globalName,
		member.user.username,
	].some(name => name?.toLocaleLowerCase() === normalized));
	if (matches.length !== 1) throw new Error(matches.length ? "That assignee name is ambiguous." : "No Organizer member matches that assignee name.");
	return matches[0].id;
}

async function createAndAnnounce(args: {
	interaction: TaskInteraction;
	services: Services;
	draftId?: string;
	correlationId?: string;
	title: string;
	description: string;
	projectText: string | null;
	assigneeId?: string;
	accountableId?: string;
	priorityId?: number;
	sizeHref?: string;
	startDate?: string;
	dueDate?: string;
	estimatedHours?: number;
	sourceLinks: string[];
	allowDuplicate?: boolean;
}) {
	const { interaction, services } = args;
	await requireCreator(interaction, services);
	const guild = interaction.guild!;
	const assignee = args.assigneeId ? await guild.members.fetch(args.assigneeId) : null;
	const assigneeOpenProjectId = assignee ? await services.db.openProjectUserId(assignee.id) : undefined;
	if (assignee && !assigneeOpenProjectId) throw new Error("The assignee is not mapped to OpenProject.");
	const accountableOverride = args.accountableId ? await services.db.openProjectUserId(args.accountableId) : undefined;
	if (args.accountableId && !accountableOverride) throw new Error("The accountable user is not mapped to OpenProject.");
	const projectId = await resolveProject(args.projectText, interaction.channelId!, guild, assignee, services);
	if (!projectId) throw new Error("Select a project; no channel or assignee-team default is configured.");
	await requireProjectAccess(interaction, projectId, services);
	const creatorOpenProjectId = await services.db.openProjectUserId(interaction.user.id);
	if (!creatorOpenProjectId) throw new Error("Your Discord account is not linked to an OpenProject user.");
	if (!await services.openProject.isProjectMember(projectId, creatorOpenProjectId)) {
		throw new Error("You are not a member of the selected OpenProject project.");
	}
	if (assigneeOpenProjectId && !await services.openProject.isProjectMember(projectId, assigneeOpenProjectId)) {
		throw new Error("The assignee is not a member of the selected OpenProject project.");
	}
	const projects = await services.openProject.projects();
	const project = projects.find(item => item.id === projectId);
	if (!project) throw new Error("The selected OpenProject project is inactive or inaccessible.");
	const accountable = await accountableFor(assignee, services);
	const accountableOpenProjectId = accountableOverride ?? accountable?.openProjectId;
	if (accountableOpenProjectId && !await services.openProject.isProjectMember(projectId, accountableOpenProjectId)) {
		throw new Error("The accountable user is not a member of the selected OpenProject project.");
	}
	validateDateOrder(args.startDate, args.dueDate);
	const duplicate = await services.openProject.possibleDuplicate(projectId, args.title);
	if (duplicate && !args.allowDuplicate) {
		throw new Error(`A similar open task already exists: ${services.openProject.workPackageUrl(duplicate.id)}. Use allow_duplicate to create anyway.`);
	}
	const types = await services.openProject.types();
	const type = types.find(item => item.name.toLowerCase() === services.config.OPENPROJECT_DEFAULT_TYPE_NAME.toLowerCase()) ?? types[0];
	const workPackage = await services.openProject.createWorkPackage({
		projectId,
		subject: args.title,
		description: args.description,
		assigneeId: assigneeOpenProjectId,
		accountableId: accountableOpenProjectId,
		priorityId: args.priorityId,
		sizeHref: args.sizeHref,
		startDate: validIsoDate(args.startDate),
		dueDate: validIsoDate(args.dueDate),
		estimatedHours: args.estimatedHours,
		sourceLinks: args.sourceLinks,
		typeId: type?.id,
		correlationId: args.correlationId ?? args.draftId,
	});
	// Persist completion immediately after the non-idempotent OpenProject POST.
	// Discord response/announcement failures must never make a successful POST
	// look retryable and create a second work package.
	if (args.draftId) {
		try {
			await services.db.completeDraft(args.draftId, workPackage.id);
		} catch (error) {
			throw new OpenProjectRequestError(`OpenProject task ${workPackage.id} was created, but its local draft could not be finalized: ${(error as Error).message}`, true);
		}
	}
	await services.db.logTaskEvent(workPackage.id, "created", interaction.user.id, { projectId, sourceLinks: args.sourceLinks })
		.catch(error => console.error("Task creation audit log failed", { workPackageId: workPackage.id, error: (error as Error).message }));
	const url = services.openProject.workPackageUrl(workPackage.id);
	const ownerIds = [assignee?.id, accountable?.discordId].filter((id): id is string => Boolean(id));
	const ping = ownerIds.map(id => `<@${id}>`).join(" ");
	const due = args.dueDate ? ` · due ${args.dueDate}` : "";
	const content = `${ping ? `${ping} ` : ""}OpenProject task created: **${workPackage.subject}** in **${project.name}**${due}\n${url}`;
	await interaction.editReply({ content: `Created ${url}` })
		.catch(error => console.error("Task creation response failed", { workPackageId: workPackage.id, error: (error as Error).message }));
	let confirmationMessageId: string | undefined;
	if (interaction.channel?.type === ChannelType.GuildText || interaction.channel?.type === ChannelType.PublicThread || interaction.channel?.type === ChannelType.PrivateThread) {
		try {
			const confirmation = await interaction.channel.send({
				content,
				allowedMentions: ownerIds.length ? { users: ownerIds } : { parse: [] },
			});
			confirmationMessageId = confirmation.id;
		} catch (error) {
			await services.db.queueConfirmation(workPackage.id, interaction.channelId!, assignee?.id, (error as Error).message)
				.catch(queueError => console.error("Task confirmation queue failed", { workPackageId: workPackage.id, error: (queueError as Error).message }));
			await services.db.logTaskEvent(workPackage.id, "confirmation_failed", interaction.user.id, { error: (error as Error).message })
				.catch(auditError => console.error("Task confirmation audit log failed", { workPackageId: workPackage.id, error: (auditError as Error).message }));
			await interaction.editReply({ content: `Created ${url}, but the channel confirmation could not be posted. The task was not created twice.` })
				.catch(responseError => console.error("Task confirmation response failed", { workPackageId: workPackage.id, error: (responseError as Error).message }));
		}
	}
	return { workPackage, confirmationMessageId };
}

async function showCreationPreview(
	interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
	services: Services,
	draft: Omit<CreationDraft, "userId" | "channelId" | "expiresAt">,
) {
	const id = await services.db.createDraft(
		"creation",
		interaction.user.id,
		interaction.channelId!,
		draft,
		services.config.OPENPROJECT_DRAFT_TTL_MINUTES,
	);
	const projectId = draft.projectText && /^\d+$/.test(draft.projectText) ? Number(draft.projectText) : undefined;
	const project = projectId ? (await services.openProject.projects()).find(item => item.id === projectId) : undefined;
	const priority = draft.priorityId ? (await services.openProject.priorities()).find(item => item.id === draft.priorityId) : undefined;
	const sizeId = draft.sizeHref ? Number(draft.sizeHref.split("/").at(-1)) : undefined;
	const size = projectId && sizeId ? (await services.openProject.sizeOptions(projectId)).find(item => item.id === sizeId) : undefined;
	const dates = draft.startDate || draft.dueDate ? `\nDates: ${draft.startDate ?? "—"} → ${draft.dueDate ?? "—"}` : "";
	const metadata = [
		draft.assigneeId ? `Assignee: <@${draft.assigneeId}>` : null,
		draft.accountableId ? `Accountable: <@${draft.accountableId}>` : null,
		priority ? `Priority: ${priority.name}` : null,
		size ? `Size: ${size.value}` : null,
		draft.estimatedHours !== undefined ? `Estimate: ${draft.estimatedHours}h` : null,
	]
		.filter(Boolean).join(" · ");
	const description = draft.description.trim() ? `\n\n${draft.description.slice(0, 1200)}` : "";
	await interaction.editReply({
		content: `Review before creating:\n**${draft.title}**\nProject: ${project?.name ?? "resolved from category/team"}${metadata ? `\n${metadata}` : ""}${dates}${description}`,
		components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder().setCustomId(`op-create-final:${id}`).setLabel("Create").setStyle(ButtonStyle.Success),
			new ButtonBuilder().setCustomId(`op-edit-final:${id}`).setLabel("Edit").setStyle(ButtonStyle.Primary),
			new ButtonBuilder().setCustomId(`op-cancel-final:${id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
		)],
	});
}

async function handleAutocomplete(interaction: AutocompleteInteraction, services: Services) {
	if (interaction.commandName !== "task") return;
	const focused = interaction.options.getFocused(true);
	const query = String(focused.value).toLowerCase();
	let choices: Array<{ name: string; value: string }> = [];
	if (focused.name === "project") {
		if (!interaction.inGuild()) return interaction.respond([]);
		const member = await interaction.guild!.members.fetch(interaction.user.id);
		const allowed = await allowedProjectIds(interaction.channelId, member, services);
		choices = (await services.openProject.projects()).filter(project => allowed.has(project.id)).map(project => ({ name: project.name, value: String(project.id) }));
	} else if (focused.name === "priority") {
		choices = (await services.openProject.priorities()).map(priority => ({ name: priority.name, value: String(priority.id) }));
	} else if (focused.name === "start_date" || focused.name === "due_date") {
		choices = dateChoices(query, focused.name === "start_date", new Date(), services.config.BOT_TIME_ZONE);
	} else if (focused.name === "size") {
		const explicitProject = interaction.options.getString("project");
		const projectId = explicitProject && /^\d+$/.test(explicitProject)
			? Number(explicitProject)
			: await categoryProject(interaction.channelId, interaction.guild!, services);
		if (projectId) choices = (await services.openProject.sizeOptions(projectId)).map(option => ({ name: option.value, value: `/api/v3/custom_options/${option.id}` }));
	} else if (focused.name === "openproject_user") {
		choices = (await services.openProject.users()).map(user => ({ name: user.name, value: String(user.id) }));
	}
	await interaction.respond(choices.filter(choice => choice.name.toLowerCase().includes(query)).slice(0, 25));
}

async function handleSlash(interaction: ChatInputCommandInteraction, services: Services) {
	if (interaction.commandName !== "task") return;
	const subcommand = interaction.options.getSubcommand();
	await interaction.deferReply({ ephemeral: true });
	if (subcommand === "reconcile") {
		requireOrganizer(interaction, services);
		const workPackageId = interaction.options.getInteger("work_package_id", true);
		const workPackage = await services.openProject.workPackage(workPackageId);
		await requireProjectAccess(interaction, projectIdFromWorkPackage(workPackage), services);
		await services.db.reconcileCreation(
			interaction.options.getString("proposal", true),
			interaction.user.id,
			workPackageId,
		);
		await interaction.editReply("Creation reconciled; no second OpenProject task was created.");
		return;
	}
	if (subcommand === "metrics") {
		requireOrganizer(interaction, services);
		const period = interaction.options.getInteger("period", true);
		if (period !== 7 && period !== 30 && period !== 90) throw new Error("Select a valid metrics period.");
		await interaction.editReply(formatProposalMetrics(await services.db.proposalMetrics(period)));
		return;
	}
	if (subcommand === "link-user") {
		requireOrganizer(interaction, services);
		const discordUser = interaction.options.getUser("discord_user", true);
		const openProjectId = Number(interaction.options.getString("openproject_user", true));
		if (!Number.isInteger(openProjectId)) throw new Error("Select a valid OpenProject user.");
		const user = (await services.openProject.users()).find(item => item.id === openProjectId);
		if (!user) throw new Error("The selected OpenProject user is not assignable in a configured project.");
		const mappings = await services.db.openProjectUserMappings();
		const collision = [...mappings].find(([discordId, mappedId]) => mappedId === openProjectId && discordId !== discordUser.id);
		if (collision) throw new Error(`That OpenProject user is already mapped to <@${collision[0]}>.`);
		await services.db.setOpenProjectUser(discordUser.id, openProjectId);
		await interaction.editReply(`Mapped <@${discordUser.id}> to OpenProject user **${user.name}**.`);
		return;
	}
	if (subcommand === "configure-category") {
		requireOrganizer(interaction, services);
		const projectId = Number(interaction.options.getString("project", true));
		const category = interaction.options.getChannel("category", true);
		if (category.type !== ChannelType.GuildCategory) throw new Error("Select a Discord category.");
		const project = (await services.openProject.projects()).find(item => item.id === projectId);
		if (!project) throw new Error("Select a valid active OpenProject project.");
		await services.db.setCategoryProject(category.id, projectId, interaction.user.id);
		await interaction.editReply(`Category **${category.name}** now defaults to **${project.name}**.`);
		return;
	}
	await requireCreator(interaction, services);
	if (subcommand === "extract") {
		requireOrganizer(interaction, services);
		if (!services.extractor.enabled) throw new Error("No task extraction provider is configured.");
		const limit = interaction.options.getInteger("message_count") ?? 20;
		const context = await collectRecentContext(interaction, limit);
		try {
			await completeAiContext(interaction, services, context);
		} catch (error) {
			if (error instanceof SensitiveContentError) {
				await services.db.recordExtraction({ source: "manual", outcome: "sensitive_block" }).catch(() => undefined);
				await interaction.editReply("This channel matched the sensitive-content heuristic. Nothing was sent to Azure.");
				return;
			}
			await services.db.recordExtraction({
				source: "manual", outcome: error instanceof StructuredOutputError ? "invalid_output" : "error",
				triggerId: context.primaryId, decision: { trigger: "slash", errorType: error instanceof StructuredOutputError ? "invalid_output" : "provider_error" },
			}).catch(() => undefined);
			throw error;
		}
		return;
	}
	if (subcommand !== "create") {
		const id = interaction.options.getInteger("id", true);
		const existingTask = await services.openProject.workPackage(id);
		await requireProjectAccess(interaction, projectIdFromWorkPackage(existingTask), services);
		if (subcommand === "announce") {
			const pending = await services.db.pendingConfirmation(id);
			const assignee = interaction.options.getUser("assignee")
				?? (pending?.assignee_discord_id ? await interaction.guild!.members.fetch(pending.assignee_discord_id).then(member => member.user).catch(() => null) : null);
			const content = `${assignee ? `<@${assignee.id}> ` : ""}OpenProject task: **${existingTask.subject}**\n${services.openProject.workPackageUrl(id)}`;
			if (!interaction.channel?.isSendable()) throw new Error("This channel cannot receive announcements.");
			await interaction.channel.send({ content, allowedMentions: assignee ? { users: [assignee.id] } : { parse: [] } });
			await services.db.clearConfirmation(id);
			await services.db.logTaskEvent(id, "announcement_retried", interaction.user.id, { assigneeDiscordId: assignee?.id });
			await interaction.editReply(`Announcement posted for ${services.openProject.workPackageUrl(id)}.`);
			return;
		}
		if (subcommand === "view") {
			const task = existingTask;
			const status = task._links.status?.title ?? "Unknown";
			const assignee = task._links.assignee?.title ?? "Unassigned";
			await interaction.editReply(`**#${task.id} ${task.subject}**\nStatus: ${status} · Assignee: ${assignee}\nDates: ${task.startDate ?? "—"} → ${task.dueDate ?? "—"}\n${services.openProject.workPackageUrl(task.id)}`);
			return;
		}
		let event = subcommand;
		if (subcommand === "assign") {
			const assignee = interaction.options.getUser("assignee", true);
			const openProjectId = await services.db.openProjectUserId(assignee.id);
			if (!openProjectId) throw new Error("The assignee is not mapped to OpenProject.");
			await services.openProject.updateWorkPackage(id, { _links: { assignee: { href: `/api/v3/users/${openProjectId}` } } });
			await services.db.logTaskEvent(id, event, interaction.user.id, { assigneeDiscordId: assignee.id });
			await interaction.editReply(`Assigned ${services.openProject.workPackageUrl(id)} to <@${assignee.id}>.`);
			return;
		}
		if (subcommand === "reschedule") {
			const parseDate = (value: string | null) => value?.toLowerCase() === "clear" ? null : validIsoDate(value);
			const startDate = parseDate(interaction.options.getString("start_date"));
			const dueDate = parseDate(interaction.options.getString("due_date"));
			if (startDate === undefined && dueDate === undefined) throw new Error("Provide at least one date, or use 'clear'.");
			await services.openProject.updateWorkPackage(id, {
				...(startDate !== undefined ? { startDate } : {}),
				...(dueDate !== undefined ? { dueDate } : {}),
			});
			await services.db.logTaskEvent(id, event, interaction.user.id, { startDate, dueDate });
			await interaction.editReply(`Rescheduled ${services.openProject.workPackageUrl(id)}.`);
			return;
		}
		const statuses = await services.openProject.statuses();
		const status = subcommand === "close"
			? statuses.find(item => item.isClosed)
			: statuses.find(item => !item.isClosed && item.isDefault) ?? statuses.find(item => !item.isClosed);
		if (!status) throw new Error(`OpenProject has no ${subcommand === "close" ? "closed" : "open"} status available.`);
		await services.openProject.updateWorkPackage(id, { _links: { status: { href: `/api/v3/statuses/${status.id}` } } });
		await services.db.logTaskEvent(id, event, interaction.user.id, { statusId: status.id });
		await interaction.editReply(`${subcommand === "close" ? "Closed" : "Reopened"} ${services.openProject.workPackageUrl(id)}.`);
		return;
	}
	const defaults = defaultTaskDates(new Date(), services.config.OPENPROJECT_DEFAULT_START_TODAY, services.config.OPENPROJECT_DEFAULT_DUE_DAYS, services.config.BOT_TIME_ZONE);
	const priority = interaction.options.getString("priority")
		? Number(interaction.options.getString("priority"))
		: (await services.openProject.priorities()).find(item => item.isDefault)?.id;
	await showCreationPreview(interaction, services, {
		title: interaction.options.getString("title", true),
		description: interaction.options.getString("description") ?? "",
		projectText: interaction.options.getString("project"),
		assigneeId: interaction.options.getUser("assignee")?.id,
		accountableId: interaction.options.getUser("accountable")?.id,
		priorityId: priority,
		sizeHref: interaction.options.getString("size") ?? undefined,
		startDate: interaction.options.getString("start_date") ?? defaults.startDate,
		dueDate: interaction.options.getString("due_date") ?? defaults.dueDate,
		estimatedHours: interaction.options.getNumber("estimated_hours") ?? undefined,
		sourceLinks: await validatedSourceLink(interaction.options.getString("source_message"), interaction),
		allowDuplicate: interaction.options.getBoolean("allow_duplicate") ?? false,
	});
}

async function handleContext(interaction: MessageContextMenuCommandInteraction, services: Services) {
	if (interaction.commandName !== taskMessageCommand.name) return;
	await requireCreator(interaction, services);
	const member = await interaction.guild!.members.fetch(interaction.user.id);
	const allowed = await allowedProjectIds(interaction.channelId, member, services);
	const projects = (await services.openProject.projects()).filter(project => allowed.has(project.id));
	if (!projects.length) throw new Error("No OpenProject project is configured for this channel or your team.");
	const defaultProject = await resolveProject(null, interaction.channelId, interaction.guild!, null, services);
	const payload = {
		userId: interaction.user.id, channelId: interaction.channelId, targetId: interaction.targetId,
		title: interaction.targetMessage.content.split("\n")[0].slice(0, 255) || "Discord follow-up",
		description: interaction.targetMessage.content.slice(0, 4000), projectId: defaultProject,
		expiresAt: Date.now() + 15 * 60_000,
	};
	const id = await services.db.createDraft("context", interaction.user.id, interaction.channelId, payload);
	const projectSelect = new StringSelectMenuBuilder().setCustomId(`op-project:${id}`).setPlaceholder("Choose an OpenProject project")
		.addOptions(projects.slice(0, 25).map(project => ({ label: project.name.slice(0, 100), value: String(project.id), default: project.id === defaultProject })));
	const assigneeSelect = new UserSelectMenuBuilder().setCustomId(`op-assignee:${id}`).setPlaceholder("Choose an optional assignee").setMinValues(0).setMaxValues(1);
	const continueButton = new ButtonBuilder().setCustomId(`op-continue:${id}`).setLabel("Continue").setStyle(ButtonStyle.Primary);
	await interaction.reply({
		content: "Choose the project and optional assignee, then continue to edit the task text and dates.", ephemeral: true,
		components: [
			new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(projectSelect),
			new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(assigneeSelect),
			new ActionRowBuilder<ButtonBuilder>().addComponents(continueButton),
		],
	});
}

async function handleContextSelect(interaction: StringSelectMenuInteraction | UserSelectMenuInteraction, services: Services) {
	if (!interaction.customId.startsWith("op-project:") && !interaction.customId.startsWith("op-assignee:")) return;
	const id = interaction.customId.split(":")[1];
	const draft = await contextDraft(id, interaction.user.id, services);
	if (interaction.customId.startsWith("op-project:")) draft.projectId = Number(interaction.values[0]);
	else draft.assigneeId = interaction.values[0] || undefined;
	await services.db.updateDraft(id, interaction.user.id, "context", draft);
	await interaction.deferUpdate();
}

async function handleContextContinue(interaction: ButtonInteraction, services: Services) {
	if (!interaction.customId.startsWith("op-continue:")) return false;
	const id = interaction.customId.split(":")[1];
	const draft = await contextDraft(id, interaction.user.id, services);
	if (!draft.projectId) throw new Error("Choose a project before continuing.");
	const defaults = defaultTaskDates(new Date(), services.config.OPENPROJECT_DEFAULT_START_TODAY, services.config.OPENPROJECT_DEFAULT_DUE_DAYS, services.config.BOT_TIME_ZONE);
	const modal = new ModalBuilder().setCustomId(`op-task2:${id}`).setTitle("Create OpenProject task");
	const fields = [
		new TextInputBuilder().setCustomId("title").setLabel("Title").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(255).setValue(draft.title),
		new TextInputBuilder().setCustomId("description").setLabel("Description (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000).setValue(draft.description),
		new TextInputBuilder().setCustomId("start_date").setLabel("Start date YYYY-MM-DD (optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(defaults.startDate ?? ""),
		new TextInputBuilder().setCustomId("due_date").setLabel("Due date YYYY-MM-DD (optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(defaults.dueDate),
	];
	modal.addComponents(...fields.map(field => new ActionRowBuilder<TextInputBuilder>().addComponents(field)));
	await interaction.showModal(modal);
	return true;
}

export const AI_CONTEXT_GAP_MS = 30 * 60 * 1000;

export function precedingUntilGap<T extends { createdTimestamp: number }>(anchorTimestamp: number, messages: T[], limit = 20) {
	const selected: T[] = [];
	let nextTimestamp = anchorTimestamp;
	for (const message of [...messages].sort((left, right) => right.createdTimestamp - left.createdTimestamp)) {
		if (message.createdTimestamp >= nextTimestamp) continue;
		if (nextTimestamp - message.createdTimestamp > AI_CONTEXT_GAP_MS) break;
		selected.push(message);
		nextTimestamp = message.createdTimestamp;
		if (selected.length >= limit) break;
	}
	return selected;
}

export function followingUntilGap<T extends { createdTimestamp: number }>(anchorTimestamp: number, messages: T[], limit = 20) {
	const selected: T[] = [];
	let previousTimestamp = anchorTimestamp;
	for (const message of [...messages].sort((left, right) => left.createdTimestamp - right.createdTimestamp)) {
		if (message.createdTimestamp <= previousTimestamp) continue;
		if (message.createdTimestamp - previousTimestamp > AI_CONTEXT_GAP_MS) break;
		selected.push(message);
		previousTimestamp = message.createdTimestamp;
		if (selected.length >= limit) break;
	}
	return selected;
}

const artifactTerms = ["doc", "document", "spreadsheet", "sheet", "form", "slides", "deck", "file", "list", "tracker"];

export function historicalContinuityScore(
	targetText: string,
	candidateText: string,
	options: { ageMs: number; sameAuthor?: boolean; mentionsTargetAuthor?: boolean },
) {
	if (options.ageMs <= AI_CONTEXT_GAP_MS || options.ageMs > 30 * 24 * 60 * 60_000) return 0;
	const target = targetText.toLocaleLowerCase();
	const candidate = candidateText.toLocaleLowerCase();
	const hasReference = /\b(?:same|that|this|the|previous|existing|last year(?:'s)?)\s+(?:doc(?:ument)?|spreadsheet|sheet|form|slides?|deck|file|list|tracker)\b/i.test(target);
	if (!hasReference) return 0;
	const sharedArtifact = artifactTerms.some(term => target.includes(term) && candidate.includes(term));
	if (!sharedArtifact) return 0;
	let score = 3;
	if (options.sameAuthor || options.mentionsTargetAuthor) score += 2;
	score += 2;
	if (/https?:\/\//i.test(candidate)) score += 2;
	const words = new Set(target.match(/[\p{L}\p{N}]{4,}/gu) ?? []);
	const overlap = [...new Set(candidate.match(/[\p{L}\p{N}]{4,}/gu) ?? [])].filter(word => words.has(word)).length;
	score += Math.min(overlap, 2);
	return score;
}

export function continuationScore(
	anchorText: string,
	candidateText: string,
	options: { gapMs: number; sameAuthor?: boolean; hasAttachment?: boolean },
) {
	if (options.gapMs <= AI_CONTEXT_GAP_MS || options.gapMs > 6 * 60 * 60_000) return 0;
	const anchor = anchorText.toLocaleLowerCase();
	const candidate = candidateText.toLocaleLowerCase();
	const bridge = /\b(?:these|below|above|following|previous|everything below|same thread|see below|screenshot|fields to replace|keep|remove this)\b/i.test(candidate);
	if (!bridge) return 0;
	const words = new Set(anchor.match(/[\p{L}\p{N}]{4,}/gu) ?? []);
	const overlap = [...new Set(candidate.match(/[\p{L}\p{N}]{4,}/gu) ?? [])].filter(word => words.has(word)).length;
	if (!overlap && !options.hasAttachment) return 0;
	return 3 + Math.min(overlap, 3) + (options.sameAuthor ? 2 : 0) + (options.hasAttachment ? 2 : 0);
}

export function appendRelevantUrls(description: string, messages: MinimizedMessage[], sourceIds: string[]) {
	const urls = new Set<string>();
	for (const message of messages) {
		if (!sourceIds.includes(message.id)) continue;
		for (const match of message.text.matchAll(/https?:\/\/[^\s<>()]+/gi)) {
			const url = match[0].replace(/[.,;:!?]+$/, "");
			if (!/^https?:\/\/(?:www\.)?discord(?:app)?\.com\//i.test(url) && !description.includes(url)) urls.add(url);
		}
	}
	let result = description.trim();
	for (const url of urls) {
		const addition = `${result ? "\n\n" : ""}${result.includes("Related links:") ? "" : "Related links:\n"}- ${url}`;
		if (result.length + addition.length > 4000) break;
		result += addition;
	}
	return result;
}

export function appendSourceLinks(
	description: string,
	records: CollectedContext["sourceRecords"],
	sourceIds: string[],
) {
	const links = [...new Set(sourceIds.flatMap(id => records.get(id)?.attachments.map(attachment => attachment.url) ?? []))];
	if (!links.length) return sanitizeGeneratedDescription(description);
	const addition = `Related links:\n${links.map(link => `- ${link}`).join("\n")}`;
	return `${sanitizeGeneratedDescription(description)}\n\n${addition}`.slice(0, 4000);
}

type ContextRole = NonNullable<MinimizedMessage["contextRole"]>;

async function collectContext(target: Message, interaction: MessageContextMenuCommandInteraction) {
	const byId = new Map<string, { message: Message; role: ContextRole }>();
	const rolePriority: Record<ContextRole, number> = { primary: 0, thread_root: 1, reply_target: 2, referenced_history: 2, preceding: 3, subsequent: 3 };
	const add = (message: Message, role: ContextRole) => {
		const existing = byId.get(message.id);
		if (!existing || rolePriority[role] < rolePriority[existing.role]) byId.set(message.id, { message, role });
	};
	const addPrecedingWindow = async (anchor: Message, includeReferencedHistory = false, includeContinuation = false) => {
		if (byId.size >= 40) return;
		const older = await anchor.channel.messages.fetch({ before: anchor.id, limit: includeReferencedHistory ? 100 : 50 }).catch(() => null);
		if (!older) return;
		for (const message of precedingUntilGap(anchor.createdTimestamp, [...older.values()], Math.min(20, 40 - byId.size))) {
			add(message, "preceding");
		}
		if (includeContinuation) {
			for (const candidate of [...older.values()]
				.filter(message => !byId.has(message.id) && !message.author.bot && !message.system)
				.map(message => ({ message, score: continuationScore(anchor.content, message.content, {
					gapMs: anchor.createdTimestamp - message.createdTimestamp,
					sameAuthor: message.author.id === anchor.author.id,
					hasAttachment: message.attachments.size > 0,
				}) }))
				.filter(candidate => candidate.score >= 5)
				.sort((left, right) => right.score - left.score || right.message.createdTimestamp - left.message.createdTimestamp)
				.slice(0, 5)) add(candidate.message, "referenced_history");
		}
		if (includeReferencedHistory) {
			const candidates = [...older.values()]
				.filter(message => !byId.has(message.id) && !message.author.bot && !message.system)
				.map(message => ({
					message,
					score: historicalContinuityScore(anchor.content, message.content, {
						ageMs: anchor.createdTimestamp - message.createdTimestamp,
						sameAuthor: message.author.id === anchor.author.id,
						mentionsTargetAuthor: message.mentions.users.has(anchor.author.id),
					}),
				}))
				.filter(candidate => candidate.score >= 7)
				.sort((left, right) => right.score - left.score || right.message.createdTimestamp - left.message.createdTimestamp)
				.slice(0, 3);
			for (const candidate of candidates) add(candidate.message, "referenced_history");
		}
	};
	const addFollowingWindow = async (anchor: Message, includeContinuation = false) => {
		if (byId.size >= 40) return;
		const newer = await anchor.channel.messages.fetch({ after: anchor.id, limit: includeContinuation ? 100 : 50 }).catch(() => null);
		if (!newer) return;
		for (const message of followingUntilGap(anchor.createdTimestamp, [...newer.values()], Math.min(20, 40 - byId.size))) {
			add(message, "subsequent");
		}
		if (includeContinuation) {
			for (const candidate of [...newer.values()]
				.filter(message => !byId.has(message.id) && !message.author.bot && !message.system)
				.map(message => ({ message, score: continuationScore(anchor.content, message.content, {
					gapMs: message.createdTimestamp - anchor.createdTimestamp,
					sameAuthor: message.author.id === anchor.author.id,
					hasAttachment: message.attachments.size > 0,
				}) }))
				.filter(candidate => candidate.score >= 5)
				.sort((left, right) => right.score - left.score || left.message.createdTimestamp - right.message.createdTimestamp)
				.slice(0, 5)) add(candidate.message, "referenced_history");
		}
	};
	const fetchReplyTarget = async (message: Message) => {
		if (!message.reference?.messageId || !message.reference.channelId) return null;
		const channel = message.reference.channelId === message.channelId
			? message.channel
			: await interaction.guild!.channels.fetch(message.reference.channelId).catch(() => null);
		if (!channel || !("messages" in channel)) return null;
		return await channel.messages.fetch(message.reference.messageId).catch(() => null);
	};

	add(target, "primary");
	await addPrecedingWindow(target, true, true);
	await addFollowingWindow(target, true);
	if (target.channel.isThread()) {
		const starter = await target.channel.fetchStarterMessage().catch(() => null);
		if (starter) {
			add(starter, "thread_root");
			await addPrecedingWindow(starter);
		}
	}
	let replyWindows = 0;
	for (const { message } of byId.values()) {
		if (replyWindows >= 8 || byId.size >= 40) break;
		const referenced = await fetchReplyTarget(message);
		if (!referenced) continue;
		add(referenced, "reply_target");
		await addPrecedingWindow(referenced);
		replyWindows++;
	}
	const aliases = new Map<string, string>();
	const reverseAliases = new Map<string, string>();
	const aliasFor = (id: string) => {
		let alias = aliases.get(id);
		if (!alias) {
			alias = `USER_${aliases.size + 1}`;
			aliases.set(id, alias);
			reverseAliases.set(alias, id);
		}
		return alias;
	};
	const normalizedName = (value: string) => value.trim().toLocaleLowerCase();
	const memberNames = (member: GuildMember) => [
		member.displayName,
		member.displayName.replace(/(?:\s*\[[^\]]+\])+\s*$/g, ""),
		member.user.globalName,
		member.user.username,
	]
		.filter((value): value is string => Boolean(value));
	const namedAliases = new Map<string, string>();
	const namedDiscordIds = new Map<string, string>();
	const primaryNames = new Set(explicitAssignmentNames(target.content));
	const explicitNames = new Set(primaryNames);
	for (const { message } of byId.values()) {
		for (const name of explicitAssignmentNames(message.content)) explicitNames.add(name);
	}
	for (const member of interaction.guild!.members.cache.values()) {
		if (member.user.bot || member.id === target.author.id) continue;
		const baseName = member.displayName.replace(/(?:\s*\[[^\]]+\])+\s*$/g, "").trim();
		if (baseName.length < 2) continue;
		const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(target.content)) {
			explicitNames.add(baseName);
			primaryNames.add(baseName);
		}
	}
	for (const name of explicitNames) {
		const contextualMatches = new Map<string, GuildMember>();
		for (const { message } of byId.values()) {
			if (message.member && memberNames(message.member).some(value => normalizedName(value) === normalizedName(name))) {
				contextualMatches.set(message.member.id, message.member);
			}
		}
		let matches = [...contextualMatches.values()];
		if (!matches.length) {
			matches = [...interaction.guild!.members.cache.values()]
				.filter(member => memberNames(member).some(value => normalizedName(value) === normalizedName(name)));
		}
		if (matches.length === 1) {
			namedAliases.set(name, aliasFor(matches[0].id));
			namedDiscordIds.set(normalizedName(name), matches[0].id);
		}
	}
	const replaceNamedAliases = (text: string) => {
		let replaced = text;
		for (const [name, alias] of namedAliases) {
			const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			replaced = replaced.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu"), alias);
		}
		return replaced;
	};
	const sourceRecords = new Map([...byId.values()].map(({ message }) => [message.id, {
		author: message.member?.displayName ?? message.author.username,
		timestamp: message.createdAt.toISOString(),
		text: message.content,
		attachments: [...message.attachments.values()].map(attachment => ({
			id: attachment.id,
			name: attachment.name ?? "attachment",
			contentType: attachment.contentType ?? undefined,
			url: attachment.url,
		})),
	}] as const));
	const messages: MinimizedMessage[] = [...byId.values()]
		.filter(({ message }) => !message.author.bot && !message.system && !message.content.startsWith("/"))
		.sort((left, right) => left.message.createdTimestamp - right.message.createdTimestamp)
		.map(({ message, role }) => {
			const raw = replaceNamedAliases(message.content.replace(/<@!?(\d+)>/g, (_, id: string) => aliasFor(id)));
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
				contextRole: role,
				priority: role === "primary",
				containedSensitiveData: containsSensitiveContent([{ id: message.id, authorAlias: "", text: raw, timestamp: "" }]),
			};
		});
	const mentionedIds = [...target.mentions.users.keys()].filter(id => id !== target.author.id);
	const namedIds = [...primaryNames].flatMap(name => namedDiscordIds.get(normalizedName(name)) ?? []);
	const explicitIds = [...new Set([...mentionedIds, ...namedIds])];
	return {
		messages,
		sourceRecords,
		reverseAliases,
		validIds: new Set(byId.keys()),
		focusIds: new Set([target.id]),
		primaryId: target.id,
		primaryAuthorId: target.author.id,
		explicitAssigneeId: explicitIds.length === 1 ? explicitIds[0] : undefined,
	};
}

async function collectRecentContext(interaction: ChatInputCommandInteraction, limit: number): Promise<CollectedContext> {
	if (!interaction.channel || !("messages" in interaction.channel)) throw new Error("This channel does not support message extraction.");
	const fetched = await interaction.channel.messages.fetch({ limit });
	const source = [...fetched.values()]
		.filter(message => !message.author.bot && !message.system && !message.content.startsWith("/"))
		.sort((left, right) => left.createdTimestamp - right.createdTimestamp);
	if (!source.length) throw new Error("No recent messages were available for extraction.");
	const aliases = new Map<string, string>();
	const reverseAliases = new Map<string, string>();
	const aliasFor = (id: string) => {
		let alias = aliases.get(id);
		if (!alias) {
			alias = `USER_${aliases.size + 1}`;
			aliases.set(id, alias);
			reverseAliases.set(alias, id);
		}
		return alias;
	};
	const sourceRecords = new Map(source.map(message => [message.id, {
		author: message.member?.displayName ?? message.author.username,
		timestamp: message.createdAt.toISOString(),
		text: message.content,
		attachments: [...message.attachments.values()].map(attachment => ({
			id: attachment.id, name: attachment.name ?? "attachment", contentType: attachment.contentType ?? undefined, url: attachment.url,
		})),
	}]));
	const messages = source.map(message => {
		const raw = message.content.replace(/<@!?(\d+)>/g, (_, id: string) => aliasFor(id));
		return {
			id: message.id, channelId: message.channelId, authorAlias: aliasFor(message.author.id), text: minimizeText(raw),
			timestamp: message.createdAt.toISOString(), replyTo: message.reference?.messageId,
			attachments: [...message.attachments.values()].map(attachment => ({
				id: attachment.id, name: attachment.name ?? "attachment", contentType: attachment.contentType ?? undefined, url: attachment.url,
			})),
			contextRole: "primary" as const,
			priority: true,
			containedSensitiveData: containsSensitiveContent([{ id: message.id, authorAlias: "", text: raw, timestamp: "" }]),
		};
	});
	const primary = source.at(-1)!;
	const mentionedIds = [...primary.mentions.users.keys()].filter(id => id !== primary.author.id);
	return {
		messages, sourceRecords, reverseAliases, validIds: new Set(source.map(message => message.id)), focusIds: new Set(source.map(message => message.id)),
		primaryId: primary.id, primaryAuthorId: primary.author.id,
		explicitAssigneeId: mentionedIds.length === 1 ? mentionedIds[0] : undefined,
	};
}

async function handleAiContext(interaction: MessageContextMenuCommandInteraction, services: Services) {
	if (interaction.commandName !== aiTaskMessageCommand.name) return;
	await requireCreator(interaction, services);
	if (!services.extractor.enabled) throw new Error("No task extraction provider is configured.");
	await interaction.deferReply({ ephemeral: true });
	const context = await collectContext(interaction.targetMessage, interaction);
	try {
		await completeAiContext(interaction, services, context);
	} catch (error) {
		if (!(error instanceof SensitiveContentError)) {
			await services.db.recordExtraction({
				source: "manual",
				outcome: error instanceof StructuredOutputError ? "invalid_output" : "error",
				triggerId: context.primaryId,
				decision: { trigger: "context_menu", errorType: error instanceof StructuredOutputError ? "invalid_output" : "provider_error" },
			}).catch(auditError => console.error("AI extraction metrics failed", { error: (auditError as Error).message }));
			throw error;
		}
		await services.db.recordExtraction({ source: "manual", outcome: "sensitive_block", triggerId: context.primaryId, decision: { trigger: "context_menu" } })
			.catch(auditError => console.error("AI extraction metrics failed", { error: (auditError as Error).message }));
		const id = randomUUID();
		sensitiveOverrides.set(id, { userId: interaction.user.id, context, expiresAt: Date.now() + 10 * 60_000 });
		setTimeout(() => sensitiveOverrides.delete(id), 10 * 60_000).unref();
		await interaction.editReply({
			content: "This context matched the sensitive-data heuristic. Nothing was sent to Azure. If this is a false positive, you can explicitly send the minimized context for this request only.",
			components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId(`op-sensitive-override:${id}`).setLabel("Send minimized context").setStyle(ButtonStyle.Danger),
			)],
		});
	}
}

async function completeAiContext(
	interaction: MessageContextMenuCommandInteraction | ChatInputCommandInteraction | ButtonInteraction,
	services: Services,
	context: CollectedContext,
	allowSensitiveContent = false,
) {
	const tentativeProjectId = await categoryProject(interaction.channelId!, interaction.guild!, services);
	const priorities = await services.openProject.priorities();
	const tentativeSizes = tentativeProjectId ? await services.openProject.sizeOptions(tentativeProjectId) : [];
	const extraction = await services.extractor.extract(context.messages, {
		allowSensitiveContent,
		metadata: { priorities: priorities.map(priority => priority.name), sizes: tentativeSizes.map(size => size.value) },
	});
	const { result, deployment } = extraction;
	const inputSnapshot = context.messages.map(({ id, authorAlias, text, timestamp, contextRole }) => ({ id, authorAlias, text, timestamp, contextRole }));
	const decisionTelemetry = { taskCount: result.tasks.length, primaryMessageIds: [...context.focusIds] };
	const candidate = result.tasks.find(task =>
		task.proposed_action !== "no_action" &&
		(task.proposed_action !== "create" || task.completion_state === "incomplete" || task.completion_state === "unknown") &&
		(task.proposed_action !== "complete" || task.completion_state === "completed") &&
		task.significance_score >= services.config.OPENPROJECT_AI_SIGNIFICANCE_THRESHOLD * (task.proposed_action === "create" ? 0.7 : 0.5) &&
		["new_assignment", "clarification", "additional_requirements", "status_update", "completion_evidence", "question", "unclear"].includes(task.context_relation) &&
		citesExtractionFocus(task.source_message_ids, context.focusIds) &&
		task.source_message_ids.every(id => context.validIds.has(id)) &&
		task.relevant_attachment_ids.every(id => [...context.sourceRecords.values()].some(record => record.attachments.some(attachment => attachment.id === id))),
	);
	if (!candidate) {
		await services.db.recordExtraction({
			source: "manual", outcome: "no_task", modelDeployment: deployment, triggerId: context.primaryId,
			 taskCount: result.tasks.length, latencyMs: extraction.latencyMs, tokenUsage: extraction.usage,
			inputSnapshot, messageAssessments: result.message_assessments, decision: { ...decisionTelemetry, outcome: "no_task" },
		});
		await interaction.editReply("No significant incomplete work was found in the selected context.");
		return;
	}
	const assigneeId = context.explicitAssigneeId ?? (candidate.assignee_alias ? context.reverseAliases.get(candidate.assignee_alias) : undefined);
	const accountableId = context.primaryAuthorId;
	const assigneeMember = assigneeId ? await interaction.guild!.members.fetch(assigneeId).catch(() => null) : null;
	const projectId = await resolveProject(null, interaction.channelId, interaction.guild!, assigneeMember, services);
	const project = projectId ? (await services.openProject.projects()).find(item => item.id === projectId) : undefined;
	const priority = candidate.priority_name
		? priorities.find(item => item.name.toLocaleLowerCase() === candidate.priority_name!.toLocaleLowerCase())
		: undefined;
	const sizes = projectId ? await services.openProject.sizeOptions(projectId) : [];
	const size = candidate.size_name
		? sizes.find(item => item.value.toLocaleLowerCase() === candidate.size_name!.toLocaleLowerCase())
		: undefined;
	const inferredDate = (value: string | null) => {
		try { return validIsoDate(value); } catch { return undefined; }
	};
	const startDate = inferredDate(candidate.start_date);
	const dueDate = inferredDate(candidate.due_date) ?? defaultAiDueDate(new Date(), priority?.name, size?.value, services.config.BOT_TIME_ZONE);
	const description = appendSourceLinks(
		appendRelevantUrls(candidate.description, context.messages, candidate.source_message_ids),
		context.sourceRecords,
		candidate.source_message_ids,
	);
	const sourceLinks = candidate.source_message_ids.map(id => {
		const source = context.messages.find(message => message.id === id);
		return messageUrl(interaction.guildId!, source?.channelId ?? interaction.channelId!, id);
	});
	const similar = projectId && services.rag ? await services.rag.findSimilar(projectId, candidate.title, description) : [];
	const match = services.config.OPENPROJECT_RAG_MODE === "review" && similar[0]?.similarity >= services.config.OPENPROJECT_RAG_SIMILARITY_THRESHOLD ? similar[0] : undefined;
	const action = resolveProposedAction(candidate.proposed_action, services.config.OPENPROJECT_RAG_MODE, Boolean(match));
	if (action === "no_action") {
		await services.db.recordExtraction({
			source: "manual", outcome: "no_task", modelDeployment: deployment, triggerId: context.primaryId,
			taskCount: result.tasks.length, latencyMs: extraction.latencyMs, tokenUsage: extraction.usage,
			inputSnapshot, messageAssessments: result.message_assessments,
			decision: { ...decisionTelemetry, requestedAction: candidate.proposed_action, outcome: "no_existing_match" },
		});
		await interaction.editReply("The discussion suggests an existing-task change, but no sufficiently close OpenProject task was found.");
		return;
	}
	if (action !== "create" && !match) {
		await services.db.recordExtraction({
			source: "manual", outcome: "no_task", modelDeployment: deployment, triggerId: context.primaryId,
			taskCount: result.tasks.length, latencyMs: extraction.latencyMs, tokenUsage: extraction.usage,
			inputSnapshot, messageAssessments: result.message_assessments,
			decision: { ...decisionTelemetry, requestedAction: candidate.proposed_action, outcome: "no_existing_match" },
		});
		await interaction.editReply("The discussion suggests an existing-task change, but no sufficiently close OpenProject task was found.");
		return;
	}
	if (projectId && match && action !== "create") {
		const proposal = await services.db.createProposal({
			requesterId: interaction.user.id, channelId: interaction.channelId, projectId,
			title: candidate.title, description, assigneeDiscordId: assigneeId, accountableDiscordId: accountableId,
			priorityId: priority?.id, sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined, startDate, dueDate,
			estimatedHours: candidate.estimated_hours ?? undefined, sourceMessageIds: candidate.source_message_ids,
			sourceLinks,
			classification: candidate.classification, modelDeployment: deployment, evidence: candidate.evidence,
			ambiguities: [...result.ambiguities, `Possible existing task match: ${match.workPackageId}`], latencyMs: extraction.latencyMs,
			tokenUsage: extraction.usage, escalationReason: extraction.escalationReason,
			retentionDays: services.config.OPENPROJECT_PROPOSAL_RETENTION_DAYS, action,
			targetWorkPackageId: match.workPackageId, targetLockVersion: match.lockVersion,
			initialSnapshot: proposalSnapshot({
				title: candidate.title, description, projectId, assigneeId, accountableId, priorityId: priority?.id,
				sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined, startDate, dueDate,
				estimatedHours: candidate.estimated_hours, action, targetWorkPackageId: match.workPackageId,
				sourceMessageIds: candidate.source_message_ids, sourceLinks,
			}),
		});
		if (proposal.reused) {
			await services.db.recordExtraction({
				source: "manual", outcome: "duplicate", modelDeployment: deployment, triggerId: context.primaryId,
				taskCount: result.tasks.length, latencyMs: extraction.latencyMs, tokenUsage: extraction.usage,
				inputSnapshot, messageAssessments: result.message_assessments,
				decision: { ...decisionTelemetry, action, targetWorkPackageId: match.workPackageId, outcome: "duplicate" },
			});
			await interaction.editReply(`This discussion already has a pending task update proposal.`);
			return;
		}
		await services.db.recordExtraction({
			source: "manual", outcome: "proposal", modelDeployment: deployment, triggerId: context.primaryId,
			taskCount: result.tasks.length, latencyMs: extraction.latencyMs, tokenUsage: extraction.usage,
			inputSnapshot, messageAssessments: result.message_assessments,
			decision: { ...decisionTelemetry, action, targetWorkPackageId: match.workPackageId, similarity: match.similarity, outcome: "proposal" },
		});
		await deliverProposalReply(interaction, services, proposal.id, {
			content: boundedDiscordContent(`**Possible ${action} for #${match.workPackageId}**\n${candidate.title}\n${description}\n\nSimilarity: ${Math.round(match.similarity * 100)}%`),
			components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId(`op-review:${proposal.id}`).setLabel("Review and apply").setStyle(ButtonStyle.Primary),
				new ButtonBuilder().setCustomId(`op-dismiss:${proposal.id}`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary),
			)],
		});
		return;
	}
	if (projectId) {
		const duplicate = await services.openProject.possibleDuplicate(projectId, candidate.title);
		if (duplicate) {
			await services.db.recordExtraction({
				source: "manual", outcome: "duplicate", modelDeployment: deployment,
				taskCount: result.tasks.length, latencyMs: extraction.latencyMs, tokenUsage: extraction.usage,
			inputSnapshot, messageAssessments: result.message_assessments, decision: {
				...decisionTelemetry, outcome: "duplicate", ragMatch: similar[0] ? { workPackageId: similar[0].workPackageId, similarity: similar[0].similarity } : null,
			},
			});
			await interaction.editReply(`A similar open task already exists: ${services.openProject.workPackageUrl(duplicate.id)}`);
			return;
		}
	}
	const proposal = await services.db.createProposal({
		requesterId: interaction.user.id, channelId: interaction.channelId, projectId,
		title: candidate.title, description,
		assigneeDiscordId: assigneeId, accountableDiscordId: accountableId, priorityId: priority?.id,
		sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined,
		startDate, dueDate, estimatedHours: candidate.estimated_hours ?? undefined,
		sourceMessageIds: candidate.source_message_ids,
		classification: candidate.classification, modelDeployment: deployment,
		evidence: candidate.evidence, ambiguities: result.ambiguities,
		latencyMs: extraction.latencyMs, tokenUsage: extraction.usage,
					escalationReason: extraction.escalationReason,
					sourceLinks,
					retentionDays: services.config.OPENPROJECT_PROPOSAL_RETENTION_DAYS,
			initialSnapshot: proposalSnapshot({
				title: candidate.title, description, projectId, assigneeId, accountableId, priorityId: priority?.id,
				sizeHref: size ? `/api/v3/custom_options/${size.id}` : undefined, startDate, dueDate,
				estimatedHours: candidate.estimated_hours, action: "create", sourceMessageIds: candidate.source_message_ids, sourceLinks,
			}),
	});
	if (proposal.reused) {
		await services.db.recordExtraction({
			source: "manual", outcome: "duplicate", modelDeployment: deployment,
			taskCount: result.tasks.length, latencyMs: extraction.latencyMs, tokenUsage: extraction.usage,
			inputSnapshot, messageAssessments: result.message_assessments, decision: { ...decisionTelemetry, outcome: "proposal" },
		});
		await interaction.editReply("This discussion already has a pending or created task proposal.");
		return;
	}
	await services.db.recordExtraction({
		source: "manual", outcome: "proposal", modelDeployment: deployment, triggerId: context.primaryId,
		taskCount: result.tasks.length, latencyMs: extraction.latencyMs, tokenUsage: extraction.usage,
		inputSnapshot, messageAssessments: result.message_assessments, decision: {
			...decisionTelemetry, action: "create", outcome: "proposal", ragMatch: similar[0] ? { workPackageId: similar[0].workPackageId, similarity: similar[0].similarity } : null,
		},
	});
	const review = new ButtonBuilder().setCustomId(`op-review:${proposal.id}`).setLabel("Review and edit").setStyle(ButtonStyle.Primary);
	const dismiss = new ButtonBuilder().setCustomId(`op-dismiss:${proposal.id}`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary);
	const duplicate = new ButtonBuilder().setCustomId(`op-duplicate:${proposal.id}`).setLabel("Already tracked").setStyle(ButtonStyle.Secondary);
	const details = [
		`Project: ${project?.name ?? "Not resolved"}`,
		`Assignee: ${assigneeId ? `<@${assigneeId}>` : "Not inferred"}`,
		`Accountable: <@${accountableId}>`,
		`Priority: ${priority?.name ?? "Not inferred"}`,
		`Size: ${size?.value ?? "Not inferred"}`,
		`Dates: ${startDate ?? "Not set"} → ${dueDate}`,
		`Estimate: ${candidate.estimated_hours !== null ? `${candidate.estimated_hours}h` : "Not inferred"}`,
	].join("\n");
	await deliverProposalReply(interaction, services, proposal.id, {
		content: boundedDiscordContent(`**${candidate.title}**\n${description}${details ? `\n\n${details}` : ""}\n\nClassification: ${candidate.classification}${result.ambiguities.length ? `\nAmbiguities: ${result.ambiguities.join("; ")}` : ""}`),
		components: [new ActionRowBuilder<ButtonBuilder>().addComponents(review, dismiss, duplicate)],
	});
}

async function handleSensitiveOverrideButton(interaction: ButtonInteraction, services: Services) {
	if (!interaction.customId.startsWith("op-sensitive-override:")) return false;
	const id = interaction.customId.split(":")[1];
	const override = sensitiveOverrides.get(id);
	if (override?.userId !== interaction.user.id || override.expiresAt <= Date.now()) {
		sensitiveOverrides.delete(id);
		throw new Error("This sensitive-content override expired. Run the message shortcut again.");
	}
	await requireCreator(interaction, services);
	sensitiveOverrides.delete(id);
	await interaction.deferUpdate();
	await completeAiContext(interaction, services, override.context, true);
	return true;
}

async function handleProposalButton(interaction: ButtonInteraction, services: Services) {
	if (!interaction.customId.startsWith("op-review:") && !interaction.customId.startsWith("op-dismiss:") && !interaction.customId.startsWith("op-duplicate:")) return;
	const id = interaction.customId.split(":")[1];
	const proposal = await services.db.proposal(id);
	if (proposal?.status !== "pending_review" || new Date(proposal.expires_at).getTime() <= Date.now() || (!proposal.permitted_reviewer_ids.includes(interaction.user.id) && proposal.requester_discord_id !== interaction.user.id)) throw new Error("You are not permitted to review this proposal, or it is no longer pending.");
	if (interaction.customId.startsWith("op-dismiss:")) {
		if (!await services.db.setProposalStatus(id, "dismissed", interaction.user.id)) {
			throw new Error("This proposal was already handled by another reviewer.");
		}
		if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
			await interaction.update({ content: "Proposal dismissed.", components: [] });
		} else {
			await interaction.message.delete().catch(() => interaction.update({ content: "This proposal is no longer pending.", components: [] }));
			if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: "Proposal dismissed.", ephemeral: true });
		}
		return;
	}
	if (interaction.customId.startsWith("op-duplicate:")) {
		if (!await services.db.setProposalStatus(id, "duplicate", interaction.user.id)) {
			throw new Error("This proposal was already handled by another reviewer.");
		}
		await interaction.update({ content: "Proposal marked as already tracked.", components: [] });
		return;
	}
	const project = proposal.project_id ? (await services.openProject.projects()).find(item => item.id === proposal.project_id) : undefined;
	const assignee = proposal.assignee_discord_id ? await interaction.guild!.members.fetch(proposal.assignee_discord_id).catch(() => null) : null;
	let dueDate = databaseDate(proposal.due_date);
	if (!dueDate) {
		const priority = proposal.priority_id ? (await services.openProject.priorities()).find(item => item.id === proposal.priority_id) : undefined;
		const sizeId = proposal.size_href ? Number(proposal.size_href.split("/").at(-1)) : undefined;
		const size = proposal.project_id && sizeId ? (await services.openProject.sizeOptions(proposal.project_id)).find(item => item.id === sizeId) : undefined;
		dueDate = defaultAiDueDate(new Date(), priority?.name, size?.value, services.config.BOT_TIME_ZONE);
	}
	const modal = new ModalBuilder().setCustomId(`op-ai:${id}`).setTitle("Review proposed task");
	const fields = [
		new TextInputBuilder().setCustomId("title").setLabel("Title").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(255).setValue(proposal.title),
		new TextInputBuilder().setCustomId("description").setLabel("Description (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000).setValue(proposal.description.slice(0, 4000)),
		new TextInputBuilder().setCustomId("project").setLabel("Project name").setStyle(TextInputStyle.Short).setRequired(true).setValue(project?.name ?? ""),
		new TextInputBuilder().setCustomId("assignee").setLabel("Assignee name (optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(assignee?.displayName ?? ""),
		new TextInputBuilder().setCustomId("due_date").setLabel("Due date YYYY-MM-DD").setStyle(TextInputStyle.Short).setRequired(true).setValue(dueDate),
	];
	modal.addComponents(...fields.map(field => new ActionRowBuilder<TextInputBuilder>().addComponents(field)));
	if (!await services.db.startProposalReview(id, interaction.user.id)) {
		throw new Error("This proposal was already handled by another reviewer.");
	}
	await interaction.showModal(modal);
}

async function handleFinalCreationButton(interaction: ButtonInteraction, services: Services) {
	if (!/^op-(?:create|edit|cancel)-final:/.test(interaction.customId)) return false;
	const id = interaction.customId.split(":")[1];
	const draft = await creationDraft(id, interaction.user.id, services);
	if (interaction.customId.startsWith("op-cancel-final:")) {
		await services.db.failDraft(id, "cancelled");
		await interaction.update({ content: "Task creation cancelled.", components: [] });
		return true;
	}
	if (interaction.customId.startsWith("op-edit-final:")) {
		const modal = new ModalBuilder().setCustomId(`op-edit-create:${id}`).setTitle("Edit task preview");
		const fields = [
			new TextInputBuilder().setCustomId("title").setLabel("Title").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(255).setValue(draft.title),
			new TextInputBuilder().setCustomId("description").setLabel("Description (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000).setValue(draft.description.slice(0, 4000)),
			new TextInputBuilder().setCustomId("start_date").setLabel("Start date YYYY-MM-DD (optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(draft.startDate ?? ""),
			new TextInputBuilder().setCustomId("due_date").setLabel("Due date YYYY-MM-DD (optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(draft.dueDate ?? ""),
		];
		modal.addComponents(...fields.map(field => new ActionRowBuilder<TextInputBuilder>().addComponents(field)));
		await interaction.showModal(modal);
		return true;
	}
	await interaction.deferReply({ ephemeral: true });
	if (!await services.db.claimDraft(id, interaction.user.id, "creation")) {
		throw new Error("This task creation was already handled by another interaction.");
	}
	if (draft.proposalId && !await services.db.claimProposal(draft.proposalId, interaction.user.id)) {
		await services.db.failDraft(id, "proposal already handled");
		throw new Error("This proposal was already handled by another reviewer.");
	}
	try {
		const created = await createAndAnnounce({ interaction, services, draftId: id, ...draft });
		if (draft.proposalId) {
			try {
				await services.db.markProposalCreated(draft.proposalId, interaction.user.id, created.workPackage.id, created.confirmationMessageId);
			} catch (error) {
				throw new OpenProjectRequestError(`OpenProject task ${created.workPackage.id} was created, but its proposal could not be finalized: ${(error as Error).message}`, true);
			}
		}
	} catch (error) {
		const ambiguous = error instanceof OpenProjectRequestError && error.ambiguous;
		if (ambiguous) {
			if (draft.proposalId) await services.db.markProposalFailed(draft.proposalId, "needs_reconciliation", interaction.user.id, error.message);
			await services.db.failDraft(id, error.message, "needs_reconciliation");
			throw new Error(`${error.message} Reconciliation ID: ${draft.proposalId ?? id}. Use /task reconcile after checking OpenProject.`);
		}
		if (draft.proposalId) await services.db.releaseProposal(draft.proposalId, (error as Error).message);
		await services.db.releaseDraft(id, (error as Error).message, services.config.OPENPROJECT_DRAFT_TTL_MINUTES);
		throw error;
	}
	return true;
}

async function handleModal(interaction: ModalSubmitInteraction, services: Services) {
	if (!interaction.customId.startsWith("op-task:") && !interaction.customId.startsWith("op-task2:") && !interaction.customId.startsWith("op-ai:") && !interaction.customId.startsWith("op-edit-create:")) return;
	await interaction.deferReply({ ephemeral: true });
	const entityId = interaction.customId.split(":")[1];
	if (interaction.customId.startsWith("op-edit-create:")) {
		const current = await creationDraft(entityId, interaction.user.id, services);
		await services.db.failDraft(entityId, "edited");
		const startDate = validIsoDate(interaction.fields.getTextInputValue("start_date") || undefined);
		const dueDate = validIsoDate(interaction.fields.getTextInputValue("due_date") || undefined);
		validateDateOrder(startDate, dueDate);
		await showCreationPreview(interaction, services, {
			...current,
			title: interaction.fields.getTextInputValue("title"),
			description: interaction.fields.getTextInputValue("description"),
			startDate,
			dueDate,
		});
		return;
	}
	const draft = interaction.customId.startsWith("op-task2:") ? await contextDraft(entityId, interaction.user.id, services) : null;
	const proposal = interaction.customId.startsWith("op-ai:") ? await services.db.proposal(entityId) : null;
	if (proposal && (proposal.status !== "pending_review" || new Date(proposal.expires_at).getTime() <= Date.now() || (!proposal.permitted_reviewer_ids.includes(interaction.user.id) && proposal.requester_discord_id !== interaction.user.id))) throw new Error("You are not permitted to review this proposal, or it is no longer pending.");
	if (proposal) {
		const project = proposal.project_id ? (await services.openProject.projects()).find(item => item.id === proposal.project_id) : undefined;
		const reviewedAssigneeId = await resolveAssigneeInput(interaction.fields.getTextInputValue("assignee"), interaction.guild!);
		const reviewedDueDate = validIsoDate(interaction.fields.getTextInputValue("due_date"));
		const args = {
			interaction,
			services,
			correlationId: proposal.id,
			title: interaction.fields.getTextInputValue("title"),
			description: interaction.fields.getTextInputValue("description"),
			projectText: interaction.fields.getTextInputValue("project"),
			assigneeId: reviewedAssigneeId,
			accountableId: proposal.accountable_discord_id ?? undefined,
			priorityId: proposal.priority_id ?? undefined,
			sizeHref: proposal.size_href ?? undefined,
			startDate: databaseDate(proposal.start_date) ?? undefined,
			dueDate: reviewedDueDate,
			estimatedHours: proposal.estimated_hours == null ? undefined : Number(proposal.estimated_hours),
			sourceLinks: proposal.source_links,
		};
		if (!await services.db.claimProposal(proposal.id, interaction.user.id)) throw new Error("This proposal is already being handled.");
		try {
			if (proposal.action !== "create" && proposal.target_work_package_id) {
				const assigneeOpenProjectId = args.assigneeId ? await services.db.openProjectUserId(args.assigneeId) : undefined;
				const accountableOpenProjectId = args.accountableId ? await services.db.openProjectUserId(args.accountableId) : undefined;
				if (args.assigneeId && !assigneeOpenProjectId) throw new Error("The assignee is not mapped to OpenProject.");
				if (args.accountableId && !accountableOpenProjectId) throw new Error("The accountable user is not mapped to OpenProject.");
				const assigneeMember = args.assigneeId ? await interaction.guild!.members.fetch(args.assigneeId).catch(() => null) : null;
				const reviewedProjectId = await resolveProject(args.projectText, interaction.channelId!, interaction.guild!, assigneeMember, services);
				if (!reviewedProjectId) throw new Error("Select an OpenProject project.");
				await requireProjectAccess(interaction, reviewedProjectId, services);
				const statuses = proposal.action === "complete" || proposal.action === "reopen" ? await services.openProject.statuses() : [];
				const status = proposal.action === "complete"
					? statuses.find(item => item.isClosed)
					: proposal.action === "reopen" ? statuses.find(item => !item.isClosed && item.isDefault) ?? statuses.find(item => !item.isClosed) : undefined;
				if ((proposal.action === "complete" || proposal.action === "reopen") && !status) throw new Error(`OpenProject has no status available for ${proposal.action}.`);
				const updated = await services.openProject.updateWorkPackage(proposal.target_work_package_id, {
					subject: args.title,
					description: { format: "markdown", raw: args.description },
					_links: {
						project: { href: `/api/v3/projects/${reviewedProjectId}` },
						...(assigneeOpenProjectId ? { assignee: { href: `/api/v3/users/${assigneeOpenProjectId}` } } : {}),
						...(accountableOpenProjectId ? { responsible: { href: `/api/v3/users/${accountableOpenProjectId}` } } : {}),
						...(args.priorityId ? { priority: { href: `/api/v3/priorities/${args.priorityId}` } } : {}),
						...(status ? { status: { href: `/api/v3/statuses/${status.id}` } } : {}),
					},
					...(args.startDate !== undefined ? { startDate: args.startDate } : {}),
					...(args.dueDate !== undefined ? { dueDate: args.dueDate } : {}),
					...(args.estimatedHours !== undefined ? { estimatedTime: `PT${args.estimatedHours}H` } : {}),
					...(args.sizeHref ? { [services.config.OPENPROJECT_SIZE_CUSTOM_FIELD]: { href: args.sizeHref } } : {}),
				}, proposal.target_lock_version ?? undefined);
				await services.db.markProposalUpdated(proposal.id, interaction.user.id, updated.id, proposalCorrections({
					original: { title: proposal.title, description: proposal.description, assigneeId: proposal.assignee_discord_id, accountableId: proposal.accountable_discord_id, priorityId: proposal.priority_id, sizeHref: proposal.size_href, startDate: proposal.start_date, dueDate: proposal.due_date, estimatedHours: proposal.estimated_hours },
					reviewed: { title: args.title, description: args.description, assigneeId: args.assigneeId, accountableId: args.accountableId, priorityId: args.priorityId, sizeHref: args.sizeHref, startDate: args.startDate, dueDate: args.dueDate, estimatedHours: args.estimatedHours },
				}), proposal.action);
				await services.db.recordFinalProposalRevision(proposal.id, proposalSnapshot({
					title: args.title, description: args.description, projectId: reviewedProjectId, assigneeId: args.assigneeId,
					accountableId: args.accountableId, priorityId: args.priorityId, sizeHref: args.sizeHref,
					startDate: args.startDate, dueDate: args.dueDate, estimatedHours: args.estimatedHours,
					action: proposal.action, targetWorkPackageId: updated.id, sourceLinks: args.sourceLinks,
				}));
				const owners = [args.assigneeId, args.accountableId].filter((id): id is string => Boolean(id));
				if (interaction.channel?.isSendable()) await interaction.channel.send({
					content: `${owners.map(id => `<@${id}>`).join(" ")}${owners.length ? " " : ""}OpenProject task updated: **${updated.subject}**\n${services.openProject.workPackageUrl(updated.id)}`,
					allowedMentions: owners.length ? { users: owners } : { parse: [] },
				});
				await interaction.editReply(`${proposal.action === "complete" ? "Completed" : proposal.action === "reopen" ? "Reopened" : "Updated"} ${services.openProject.workPackageUrl(updated.id)}.`);
				return;
			}
			const created = await createAndAnnounce(args);
			try {
				await services.db.markProposalCreated(
					proposal.id,
					interaction.user.id,
					created.workPackage.id,
					created.confirmationMessageId,
					proposalCorrections({
						original: {
							title: proposal.title, description: proposal.description, projectName: project?.name,
							assigneeId: proposal.assignee_discord_id, accountableId: proposal.accountable_discord_id,
							priorityId: proposal.priority_id, sizeHref: proposal.size_href,
							startDate: proposal.start_date, dueDate: proposal.due_date,
							estimatedHours: proposal.estimated_hours,
						},
						reviewed: {
							title: args.title, description: args.description,
							projectName: args.projectText ?? undefined, assigneeId: args.assigneeId,
							accountableId: args.accountableId, priorityId: args.priorityId,
							sizeHref: args.sizeHref, startDate: args.startDate,
							dueDate: args.dueDate, estimatedHours: args.estimatedHours,
						},
					}),
				);
				await services.db.recordFinalProposalRevision(proposal.id, proposalSnapshot({
					title: args.title, description: args.description, projectId: proposal.project_id, assigneeId: args.assigneeId,
					accountableId: args.accountableId, priorityId: args.priorityId, sizeHref: args.sizeHref,
					startDate: args.startDate, dueDate: args.dueDate, estimatedHours: args.estimatedHours,
					action: "create", targetWorkPackageId: created.workPackage.id, sourceLinks: args.sourceLinks,
				}));
			} catch (error) {
				throw new OpenProjectRequestError(`OpenProject task ${created.workPackage.id} was created, but its proposal could not be finalized: ${(error as Error).message}`, true);
			}
		} catch (error) {
			if (error instanceof OpenProjectRequestError && error.ambiguous) {
				await services.db.markProposalFailed(proposal.id, "needs_reconciliation", interaction.user.id, error.message);
				throw new Error(`${error.message} Reconciliation ID: ${proposal.id}. Use /task reconcile after checking OpenProject.`);
			}
			await services.db.releaseProposal(proposal.id, (error as Error).message);
			throw error;
		}
		return;
	}
	if (!draft) return;
	const startDate = validIsoDate(interaction.fields.getTextInputValue("start_date") || undefined);
	const dueDate = validIsoDate(interaction.fields.getTextInputValue("due_date") || undefined);
	await showCreationPreview(interaction, services, {
		title: interaction.fields.getTextInputValue("title"),
		description: interaction.fields.getTextInputValue("description"),
		projectText: String(draft.projectId),
		assigneeId: draft.assigneeId,
		startDate,
		dueDate,
		sourceLinks: [messageUrl(interaction.guildId!, interaction.channelId!, draft.targetId)],
	});
	await services.db.failDraft(entityId, "context-complete");
}

export function registerTaskInteractions(client: Client, services: Services) {
	client.on("interactionCreate", async interaction => {
		try {
			const isTaskInteraction =
				((interaction.isAutocomplete() || interaction.isChatInputCommand()) && interaction.commandName === taskCommand.name) ||
				(interaction.isMessageContextMenuCommand() && (interaction.commandName === taskMessageCommand.name || interaction.commandName === aiTaskMessageCommand.name)) ||
				((interaction.isStringSelectMenu() || interaction.isUserSelectMenu() || interaction.isButton() || interaction.isModalSubmit()) && interaction.customId.startsWith("op-"));
			if (!isTaskInteraction) return;
			if (!interaction.inGuild() || !isOrganizerGuild(services.config, interaction.guildId)) {
				if (interaction.isAutocomplete()) await interaction.respond([]);
				else throw new Error("OpenProject tasks are available only in the Organizer Discord server.");
				return;
			}
			if (interaction.isAutocomplete()) await handleAutocomplete(interaction, services);
			else if (interaction.isChatInputCommand()) await handleSlash(interaction, services);
			else if (interaction.isMessageContextMenuCommand()) {
				await handleContext(interaction, services);
				await handleAiContext(interaction, services);
			}
			else if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) await handleContextSelect(interaction, services);
			else if (interaction.isButton()) {
				if (!await handleSensitiveOverrideButton(interaction, services) && !await handleContextContinue(interaction, services) && !await handleFinalCreationButton(interaction, services)) await handleProposalButton(interaction, services);
			}
			else if (interaction.isModalSubmit()) await handleModal(interaction, services);
		} catch (error) {
			console.error("Task interaction failed", error);
			const content = `Could not create task: ${(error as Error).message}`;
			if (interaction.isRepliable()) {
				if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
				else await interaction.reply({ content, ephemeral: true });
			}
		}
	});
}
