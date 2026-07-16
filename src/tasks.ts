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
	PermissionFlagsBits,
	StringSelectMenuBuilder,
	UserSelectMenuBuilder,
	StringSelectMenuInteraction,
	UserSelectMenuInteraction,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { IntegrationConfig, TeamMapping } from "./config.js";
import { Database } from "./database.js";
import { OpenProjectClient, OpenProjectRequestError } from "./openproject.js";
import { containsSensitiveContent, minimizeText, SensitiveContentError, type MinimizedMessage, type TaskExtractor } from "./azure-openai.js";

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

type Services = { config: IntegrationConfig; db: Database; openProject: OpenProjectClient; extractor: TaskExtractor };
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
	reverseAliases: Map<string, string>;
	validIds: Set<string>;
};

const organizerGuildId = "1022942414090027008";
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

export function defaultTaskDates(now: Date, startToday: boolean, dueDays: number) {
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const due = new Date(start);
	due.setUTCDate(due.getUTCDate() + dueDays);
	return {
		startDate: startToday ? start.toISOString().slice(0, 10) : undefined,
		dueDate: due.toISOString().slice(0, 10),
	};
}

function validateDateOrder(startDate?: string | null, dueDate?: string | null) {
	if (startDate && dueDate && startDate > dueDate) throw new Error("The start date cannot be after the due date.");
}

function dateChoices(query: string) {
	const today = new Date();
	const choices: Array<{ name: string; value: string }> = [];
	for (let offset = 0; offset < 31; offset++) {
		const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset));
		const value = date.toISOString().slice(0, 10);
		const label = offset === 0 ? `Today — ${value}` : offset === 1 ? `Tomorrow — ${value}` : value;
		choices.push({ name: label, value });
	}
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
	await assignee.guild.members.fetch();
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
	if (!interaction.inGuild() || interaction.guildId !== organizerGuildId || services.config.ORGANIZER_GUILD_ID !== organizerGuildId) {
		throw new Error("OpenProject tasks are available only in the Organizer Discord server.");
	}
	if (services.config.blockedChannels.has(interaction.channelId!)) throw new Error("Task creation is disabled in this channel.");
	const member = await interaction.guild!.members.fetch(interaction.user.id);
	if (!member.roles.cache.has(services.config.ORGANIZER_GUILD_MEMBER_ROLE_ID)) {
		throw new Error("You need the Members role to create or manage OpenProject tasks.");
	}
	return member;
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
	if (!interaction.inGuild() || interaction.guildId !== organizerGuildId || services.config.ORGANIZER_GUILD_ID !== organizerGuildId || !interaction.member || !("roles" in interaction.member)) {
		throw new Error("OpenProject configuration is available only in the Organizer Discord server.");
	}
	const member = interaction.member as GuildMember;
	if (!member.roles.cache.has(process.env.ORGANIZER_GUILD_ORGANIZER_ROLE_ID ?? "") && !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
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
	if (explicit && /^\d+$/.test(explicit)) return Number(explicit);
	const categoryDefault = await categoryProject(channelId, guild, services);
	if (categoryDefault) return categoryDefault;
	return matchedTeam(assignee, services.config.teamRoles)?.[1].projectId;
}

async function createAndAnnounce(args: {
	interaction: TaskInteraction;
	services: Services;
	draftId?: string;
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
		correlationId: args.draftId,
	});
	// Persist completion immediately after the non-idempotent OpenProject POST.
	// Discord response/announcement failures must never make a successful POST
	// look retryable and create a second work package.
	if (args.draftId) await services.db.completeDraft(args.draftId, workPackage.id);
	await services.db.logTaskEvent(workPackage.id, "created", interaction.user.id, { projectId, sourceLinks: args.sourceLinks });
	const url = services.openProject.workPackageUrl(workPackage.id);
	const ping = assignee ? `<@${assignee.id}> ` : "";
	const due = args.dueDate ? ` · due ${args.dueDate}` : "";
	const content = `${ping}OpenProject task created: **${workPackage.subject}** in **${project.name}**${due}\n${url}`;
	await interaction.editReply({ content: `Created ${url}` });
	let confirmationMessageId: string | undefined;
	if (interaction.channel?.type === ChannelType.GuildText || interaction.channel?.type === ChannelType.PublicThread || interaction.channel?.type === ChannelType.PrivateThread) {
		try {
			const confirmation = await interaction.channel.send({
				content,
				allowedMentions: assignee ? { users: [assignee.id] } : { parse: [] },
			});
			confirmationMessageId = confirmation.id;
		} catch (error) {
			await services.db.logTaskEvent(workPackage.id, "confirmation_failed", interaction.user.id, { error: (error as Error).message });
			await interaction.editReply({ content: `Created ${url}, but the channel confirmation could not be posted. The task was not created twice.` });
		}
	}
	return { workPackage, confirmationMessageId };
}

async function showCreationPreview(
	interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
	services: Services,
	draft: Omit<CreationDraft, "userId" | "channelId" | "expiresAt">,
) {
	const id = await services.db.createDraft("creation", interaction.user.id, interaction.channelId!, draft);
	const projectId = draft.projectText && /^\d+$/.test(draft.projectText) ? Number(draft.projectText) : undefined;
	const project = projectId ? (await services.openProject.projects()).find(item => item.id === projectId) : undefined;
	const dates = draft.startDate || draft.dueDate ? `\nDates: ${draft.startDate ?? "—"} → ${draft.dueDate ?? "—"}` : "";
	const description = draft.description.trim() ? `\n\n${draft.description.slice(0, 1200)}` : "";
	await interaction.editReply({
		content: `Review before creating:\n**${draft.title}**\nProject: ${project?.name ?? "resolved from category/team"}${dates}${description}`,
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
		choices = dateChoices(query);
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
	if (subcommand === "link-user") {
		requireOrganizer(interaction, services);
		const discordUser = interaction.options.getUser("discord_user", true);
		const openProjectId = Number(interaction.options.getString("openproject_user", true));
		if (!Number.isInteger(openProjectId)) throw new Error("Select a valid OpenProject user.");
		const user = (await services.openProject.users()).find(item => item.id === openProjectId);
		if (!user) throw new Error("The selected OpenProject user is inactive or inaccessible.");
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
	if (subcommand !== "create") {
		const id = interaction.options.getInteger("id", true);
		const existingTask = await services.openProject.workPackage(id);
		await requireProjectAccess(interaction, projectIdFromWorkPackage(existingTask), services);
		if (subcommand === "announce") {
			const assignee = interaction.options.getUser("assignee");
			const content = `${assignee ? `<@${assignee.id}> ` : ""}OpenProject task: **${existingTask.subject}**\n${services.openProject.workPackageUrl(id)}`;
			if (!interaction.channel?.isSendable()) throw new Error("This channel cannot receive announcements.");
			await interaction.channel.send({ content, allowedMentions: assignee ? { users: [assignee.id] } : { parse: [] } });
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
	const defaults = defaultTaskDates(new Date(), services.config.OPENPROJECT_DEFAULT_START_TODAY, services.config.OPENPROJECT_DEFAULT_DUE_DAYS);
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
	const defaults = defaultTaskDates(new Date(), services.config.OPENPROJECT_DEFAULT_START_TODAY, services.config.OPENPROJECT_DEFAULT_DUE_DAYS);
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
			await services.db.markProposalCreated(draft.proposalId, interaction.user.id, created.workPackage.id, created.confirmationMessageId);
		}
		await services.db.completeDraft(id, created.workPackage.id);
	} catch (error) {
		if (draft.proposalId) {
			const ambiguous = error instanceof OpenProjectRequestError && error.ambiguous;
			await services.db.markProposalFailed(draft.proposalId, ambiguous ? "needs_reconciliation" : "failed", interaction.user.id, (error as Error).message);
		}
		await services.db.failDraft(id, (error as Error).message, error instanceof OpenProjectRequestError && error.ambiguous ? "needs_reconciliation" : "failed");
		if (error instanceof OpenProjectRequestError && error.ambiguous) {
			throw new Error(`${error.message} Reconciliation ID: ${draft.proposalId ?? id}. Use /task reconcile after checking OpenProject.`);
		}
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
	const sourceIds = proposal?.source_message_ids ?? [draft?.targetId ?? entityId];
	await showCreationPreview(interaction, services, {
		title: interaction.fields.getTextInputValue("title"),
		description: interaction.fields.getTextInputValue("description"),
		projectText: draft ? String(draft.projectId) : interaction.fields.getTextInputValue("project") || null,
		assigneeId: draft ? draft.assigneeId : interaction.fields.getTextInputValue("assignee") || undefined,
		startDate: draft ? interaction.fields.getTextInputValue("start_date") || undefined : undefined,
		dueDate: interaction.fields.getTextInputValue("due_date") || undefined,
		sourceLinks: proposal?.source_links ?? sourceIds.map(id => messageUrl(interaction.guildId!, interaction.channelId!, id)),
		proposalId: proposal?.id,
	});
	if (draft) await services.db.failDraft(entityId, "context-complete");
}

export function registerTaskInteractions(client: Client, services: Services) {
	client.on("interactionCreate", async interaction => {
		try {
			if (interaction.isAutocomplete()) await handleAutocomplete(interaction, services);
			else if (interaction.isChatInputCommand()) await handleSlash(interaction, services);
			else if (interaction.isMessageContextMenuCommand()) {
				await handleContext(interaction, services);
			}
			else if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) await handleContextSelect(interaction, services);
			else if (interaction.isButton()) {
				if (!await handleContextContinue(interaction, services) && !await handleFinalCreationButton(interaction, services)) return;
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
