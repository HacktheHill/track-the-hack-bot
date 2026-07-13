import {
	ApplicationCommandType,
	AutocompleteInteraction,
	ChatInputCommandInteraction,
	Client,
	ContextMenuCommandBuilder,
	GuildMember,
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
import { OpenProjectClient } from "./openproject.js";
import { AzureTaskExtractor, minimizeText, type MinimizedMessage } from "./azure-openai.js";

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
				option.setName("description").setDescription("Task description").setRequired(true).setMaxLength(2000),
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
			.addStringOption(option => option.setName("start_date").setDescription("Start date (YYYY-MM-DD)"))
			.addStringOption(option => option.setName("due_date").setDescription("Due date (YYYY-MM-DD)"))
			.addNumberOption(option => option.setName("estimated_hours").setDescription("Estimated work in hours").setMinValue(0))
			.addIntegerOption(option => option.setName("story_points").setDescription("Story points").setMinValue(0))
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
	.addSubcommand(command => command.setName("link-user").setDescription("Map a Discord user to an OpenProject user")
		.addUserOption(option => option.setName("discord_user").setDescription("Discord user").setRequired(true))
		.addStringOption(option => option.setName("openproject_user").setDescription("OpenProject user").setRequired(true).setAutocomplete(true)))
	.addSubcommand(command => command.setName("configure-channel").setDescription("Set this channel's default OpenProject project")
		.addStringOption(option => option.setName("project").setDescription("OpenProject project").setRequired(true).setAutocomplete(true)),
	);

export const taskMessageCommand = new ContextMenuCommandBuilder()
	.setName("Create OpenProject task")
	.setType(ApplicationCommandType.Message);

export const aiTaskMessageCommand = new ContextMenuCommandBuilder()
	.setName("Draft OpenProject task with AI")
	.setType(ApplicationCommandType.Message);

type Services = { config: IntegrationConfig; db: Database; openProject: OpenProjectClient; extractor: AzureTaskExtractor };
type ContextDraft = {
	userId: string; channelId: string; targetId: string; title: string; description: string;
	projectId?: number; assigneeId?: string; expiresAt: number;
};
const contextDrafts = new Map<string, ContextDraft>();

function contextDraft(id: string, userId: string) {
	const draft = contextDrafts.get(id);
	if (!draft || draft.userId !== userId || draft.expiresAt < Date.now()) {
		contextDrafts.delete(id);
		throw new Error("This task draft expired. Open the message shortcut again.");
	}
	return draft;
}

function messageUrl(guildId: string, channelId: string, messageId: string) {
	return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
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

async function requireCreator(interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction | ModalSubmitInteraction, services: Services) {
	if (!interaction.inGuild()) throw new Error("Tasks can only be created in a server.");
	if (services.config.blockedChannels.has(interaction.channelId!)) throw new Error("Task creation is disabled in this channel.");
	const id = await services.db.openProjectUserId(interaction.user.id);
	if (!id) throw new Error("Your Discord account is not mapped to an OpenProject user.");
}

function requireOrganizer(interaction: ChatInputCommandInteraction) {
	if (!interaction.inGuild() || !interaction.member || !("roles" in interaction.member)) throw new Error("This command can only be used in a server.");
	const member = interaction.member as GuildMember;
	if (!member.roles.cache.has(process.env.ORGANIZER_GUILD_ORGANIZER_ROLE_ID ?? "") && !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
		throw new Error("Only organizers can change OpenProject mappings.");
	}
}

async function resolveProject(
	explicit: string | null,
	channelId: string,
	assignee: GuildMember | null,
	services: Services,
) {
	if (explicit && /^\d+$/.test(explicit)) return Number(explicit);
	const channelDefault = await services.db.channelProject(channelId) ?? services.config.channelProjects[channelId];
	if (channelDefault) return channelDefault;
	return matchedTeam(assignee, services.config.teamRoles)?.[1].projectId;
}

async function createAndAnnounce(args: {
	interaction: ChatInputCommandInteraction | ModalSubmitInteraction;
	services: Services;
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
	storyPoints?: number;
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
	const projectId = await resolveProject(args.projectText, interaction.channelId!, assignee, services);
	if (!projectId) throw new Error("Select a project; no channel or assignee-team default is configured.");
	const projects = await services.openProject.projects();
	const project = projects.find(item => item.id === projectId);
	if (!project) throw new Error("The selected OpenProject project is inactive or inaccessible.");
	const accountable = await accountableFor(assignee, services);
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
		accountableId: accountableOverride ?? accountable?.openProjectId,
		priorityId: args.priorityId,
		sizeHref: args.sizeHref,
		startDate: validIsoDate(args.startDate),
		dueDate: validIsoDate(args.dueDate),
		estimatedHours: args.estimatedHours,
		storyPoints: args.storyPoints,
		sourceLinks: args.sourceLinks,
		typeId: type?.id,
	});
	await services.db.logTaskEvent(workPackage.id, "created", interaction.user.id, { projectId, sourceLinks: args.sourceLinks });
	const url = services.openProject.workPackageUrl(workPackage.id);
	const ping = assignee ? `<@${assignee.id}> ` : "";
	const due = args.dueDate ? ` · due ${args.dueDate}` : "";
	const content = `${ping}OpenProject task created: **${workPackage.subject}** in **${project.name}**${due}\n${url}`;
	await interaction.editReply({ content: `Created ${url}` });
	if (interaction.channel?.type === ChannelType.GuildText || interaction.channel?.type === ChannelType.PublicThread || interaction.channel?.type === ChannelType.PrivateThread) {
		await interaction.channel.send({
			content,
			allowedMentions: assignee ? { users: [assignee.id] } : { parse: [] },
		});
	}
	return workPackage;
}

async function handleAutocomplete(interaction: AutocompleteInteraction, services: Services) {
	if (interaction.commandName !== "task") return;
	const focused = interaction.options.getFocused(true);
	const query = String(focused.value).toLowerCase();
	let choices: Array<{ name: string; value: string }> = [];
	if (focused.name === "project") {
		choices = (await services.openProject.projects()).map(project => ({ name: project.name, value: String(project.id) }));
	} else if (focused.name === "priority") {
		choices = (await services.openProject.priorities()).map(priority => ({ name: priority.name, value: String(priority.id) }));
	} else if (focused.name === "size") {
		const explicitProject = interaction.options.getString("project");
		const projectId = explicitProject && /^\d+$/.test(explicitProject)
			? Number(explicitProject)
			: await services.db.channelProject(interaction.channelId) ?? services.config.channelProjects[interaction.channelId];
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
	if (subcommand === "link-user") {
		requireOrganizer(interaction);
		const discordUser = interaction.options.getUser("discord_user", true);
		const openProjectId = Number(interaction.options.getString("openproject_user", true));
		if (!Number.isInteger(openProjectId)) throw new Error("Select a valid OpenProject user.");
		const user = (await services.openProject.users()).find(item => item.id === openProjectId);
		if (!user) throw new Error("The selected OpenProject user is inactive or inaccessible.");
		await services.db.setOpenProjectUser(discordUser.id, openProjectId);
		await interaction.editReply(`Mapped <@${discordUser.id}> to OpenProject user **${user.name}**.`);
		return;
	}
	if (subcommand === "configure-channel") {
		requireOrganizer(interaction);
		const projectId = Number(interaction.options.getString("project", true));
		const project = (await services.openProject.projects()).find(item => item.id === projectId);
		if (!project) throw new Error("Select a valid active OpenProject project.");
		await services.db.setChannelProject(interaction.channelId, projectId, interaction.user.id);
		await interaction.editReply(`This channel now defaults to **${project.name}**.`);
		return;
	}
	await requireCreator(interaction, services);
	if (subcommand !== "create") {
		const id = interaction.options.getInteger("id", true);
		if (subcommand === "view") {
			const task = await services.openProject.workPackage(id);
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
	await createAndAnnounce({
		interaction,
		services,
		title: interaction.options.getString("title", true),
		description: interaction.options.getString("description", true),
		projectText: interaction.options.getString("project"),
		assigneeId: interaction.options.getUser("assignee")?.id,
		accountableId: interaction.options.getUser("accountable")?.id,
		priorityId: priority,
		sizeHref: interaction.options.getString("size") ?? undefined,
		startDate: interaction.options.getString("start_date") ?? defaults.startDate,
		dueDate: interaction.options.getString("due_date") ?? defaults.dueDate,
		estimatedHours: interaction.options.getNumber("estimated_hours") ?? undefined,
		storyPoints: interaction.options.getInteger("story_points") ?? undefined,
		sourceLinks: interaction.options.getString("source_message") ? [interaction.options.getString("source_message", true)] : [],
		allowDuplicate: interaction.options.getBoolean("allow_duplicate") ?? false,
	});
}

async function handleContext(interaction: MessageContextMenuCommandInteraction, services: Services) {
	if (interaction.commandName !== taskMessageCommand.name) return;
	await requireCreator(interaction, services);
	const projects = await services.openProject.projects();
	const defaultProject = await resolveProject(null, interaction.channelId, null, services);
	const id = randomUUID();
	contextDrafts.set(id, {
		userId: interaction.user.id, channelId: interaction.channelId, targetId: interaction.targetId,
		title: interaction.targetMessage.content.split("\n")[0].slice(0, 255) || "Discord follow-up",
		description: interaction.targetMessage.content.slice(0, 4000), projectId: defaultProject,
		expiresAt: Date.now() + 15 * 60_000,
	});
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

async function handleContextSelect(interaction: StringSelectMenuInteraction | UserSelectMenuInteraction) {
	if (!interaction.customId.startsWith("op-project:") && !interaction.customId.startsWith("op-assignee:")) return;
	const id = interaction.customId.split(":")[1];
	const draft = contextDraft(id, interaction.user.id);
	if (interaction.customId.startsWith("op-project:")) draft.projectId = Number(interaction.values[0]);
	else draft.assigneeId = interaction.values[0] || undefined;
	await interaction.deferUpdate();
}

async function handleContextContinue(interaction: ButtonInteraction, services: Services) {
	if (!interaction.customId.startsWith("op-continue:")) return false;
	const id = interaction.customId.split(":")[1];
	const draft = contextDraft(id, interaction.user.id);
	if (!draft.projectId) throw new Error("Choose a project before continuing.");
	const defaults = defaultTaskDates(new Date(), services.config.OPENPROJECT_DEFAULT_START_TODAY, services.config.OPENPROJECT_DEFAULT_DUE_DAYS);
	const modal = new ModalBuilder().setCustomId(`op-task2:${id}`).setTitle("Create OpenProject task");
	const fields = [
		new TextInputBuilder().setCustomId("title").setLabel("Title").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(255).setValue(draft.title),
		new TextInputBuilder().setCustomId("description").setLabel("Description").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000).setValue(draft.description),
		new TextInputBuilder().setCustomId("start_date").setLabel("Start date YYYY-MM-DD (optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(defaults.startDate ?? ""),
		new TextInputBuilder().setCustomId("due_date").setLabel("Due date YYYY-MM-DD (optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(defaults.dueDate),
	];
	modal.addComponents(...fields.map(field => new ActionRowBuilder<TextInputBuilder>().addComponents(field)));
	await interaction.showModal(modal);
	return true;
}

async function collectContext(target: Message, interaction: MessageContextMenuCommandInteraction) {
	const byId = new Map<string, Message>();
	byId.set(target.id, target);
	if (target.reference?.messageId) {
		const referenced = await target.channel.messages.fetch(target.reference.messageId).catch(() => null);
		if (referenced) byId.set(referenced.id, referenced);
	}
	if (target.channel.isThread()) {
		const starter = await target.channel.fetchStarterMessage().catch(() => null);
		if (starter) byId.set(starter.id, starter);
	}
	const recent = await target.channel.messages.fetch({ limit: 100 });
	for (const message of recent.sort((a, b) => b.createdTimestamp - a.createdTimestamp).first(20)) byId.set(message.id, message);
	const mentionedIds = new Set<string>([...target.mentions.users.keys()]);
	let mentionCount = 0;
	for (const message of recent.values()) {
		if (mentionCount >= 3) break;
		if ([...mentionedIds].some(id => message.mentions.users.has(id)) && !byId.has(message.id)) {
			byId.set(message.id, message);
			mentionCount++;
		}
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
	const messages: MinimizedMessage[] = [...byId.values()]
		.filter(message => !message.author.bot && !message.system && !message.content.startsWith("/"))
		.sort((a, b) => a.createdTimestamp - b.createdTimestamp)
		.map(message => ({
			id: message.id,
			authorAlias: aliasFor(message.author.id),
			text: minimizeText(message.content.replace(/<@!?(\d+)>/g, (_, id: string) => aliasFor(id))),
			timestamp: message.createdAt.toISOString(),
			replyTo: message.reference?.messageId,
		}));
	return { messages, reverseAliases, validIds: new Set(byId.keys()) };
}

async function handleAiContext(interaction: MessageContextMenuCommandInteraction, services: Services) {
	if (interaction.commandName !== aiTaskMessageCommand.name) return;
	await requireCreator(interaction, services);
	if (!services.config.aiChannels.has(interaction.channelId)) throw new Error("AI extraction is not enabled in this channel.");
	if (!services.extractor.enabled) throw new Error("Azure OpenAI is not configured.");
	await interaction.deferReply({ ephemeral: true });
	const context = await collectContext(interaction.targetMessage, interaction);
	const { result, deployment } = await services.extractor.extract(context.messages);
	const candidate = result.tasks.find(task =>
		(task.classification === "explicit_commitment" || task.classification === "direct_assignment") &&
		task.source_message_ids.every(id => context.validIds.has(id)),
	);
	if (!candidate) {
		await interaction.editReply("No explicit commitment or direct assignment was found in the selected context.");
		return;
	}
	const assigneeId = candidate.assignee_alias ? context.reverseAliases.get(candidate.assignee_alias) : undefined;
	const assigneeMember = assigneeId ? await interaction.guild!.members.fetch(assigneeId).catch(() => null) : null;
	const projectId = await resolveProject(null, interaction.channelId, assigneeMember, services);
	if (projectId) {
		const duplicate = await services.openProject.possibleDuplicate(projectId, candidate.title);
		if (duplicate) {
			await interaction.editReply(`A similar open task already exists: ${services.openProject.workPackageUrl(duplicate.id)}`);
			return;
		}
	}
	const proposalId = await services.db.createProposal({
		requesterId: interaction.user.id, channelId: interaction.channelId, projectId,
		title: candidate.title, description: candidate.description,
		assigneeDiscordId: assigneeId, dueDate: candidate.due_date ?? undefined,
		sourceMessageIds: candidate.source_message_ids,
		classification: candidate.classification, modelDeployment: deployment,
	});
	const review = new ButtonBuilder().setCustomId(`op-review:${proposalId}`).setLabel("Review and edit").setStyle(ButtonStyle.Primary);
	const dismiss = new ButtonBuilder().setCustomId(`op-dismiss:${proposalId}`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary);
	await interaction.editReply({
		content: `**${candidate.title}**\n${candidate.description}\n\nClassification: ${candidate.classification}${result.ambiguities.length ? `\nAmbiguities: ${result.ambiguities.join("; ")}` : ""}`,
		components: [new ActionRowBuilder<ButtonBuilder>().addComponents(review, dismiss)],
	});
}

async function handleProposalButton(interaction: ButtonInteraction, services: Services) {
	if (!interaction.customId.startsWith("op-review:") && !interaction.customId.startsWith("op-dismiss:")) return;
	const id = interaction.customId.split(":")[1];
	const proposal = await services.db.proposal(id);
	if (!proposal || (!proposal.permitted_reviewer_ids.includes(interaction.user.id) && proposal.requester_discord_id !== interaction.user.id)) throw new Error("You are not permitted to review this proposal, or it has expired.");
	if (interaction.customId.startsWith("op-dismiss:")) {
		await services.db.setProposalStatus(id, "dismissed", interaction.user.id);
		await interaction.update({ content: "Proposal dismissed.", components: [] });
		return;
	}
	const modal = new ModalBuilder().setCustomId(`op-ai:${id}`).setTitle("Review proposed task");
	const fields = [
		new TextInputBuilder().setCustomId("title").setLabel("Title").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(255).setValue(proposal.title),
		new TextInputBuilder().setCustomId("description").setLabel("Description").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000).setValue(proposal.description.slice(0, 4000)),
		new TextInputBuilder().setCustomId("project").setLabel("Project ID").setStyle(TextInputStyle.Short).setRequired(true).setValue(proposal.project_id ? String(proposal.project_id) : ""),
		new TextInputBuilder().setCustomId("assignee").setLabel("Assignee Discord ID (optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(proposal.assignee_discord_id ?? ""),
		new TextInputBuilder().setCustomId("due_date").setLabel("Due date YYYY-MM-DD (optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(proposal.due_date ? String(proposal.due_date).slice(0, 10) : ""),
	];
	modal.addComponents(...fields.map(field => new ActionRowBuilder<TextInputBuilder>().addComponents(field)));
	await interaction.showModal(modal);
}

async function handleModal(interaction: ModalSubmitInteraction, services: Services) {
	if (!interaction.customId.startsWith("op-task:") && !interaction.customId.startsWith("op-task2:") && !interaction.customId.startsWith("op-ai:")) return;
	await interaction.deferReply({ ephemeral: true });
	const entityId = interaction.customId.split(":")[1];
	const draft = interaction.customId.startsWith("op-task2:") ? contextDraft(entityId, interaction.user.id) : null;
	const proposal = interaction.customId.startsWith("op-ai:") ? await services.db.proposal(entityId) : null;
	if (proposal && !proposal.permitted_reviewer_ids.includes(interaction.user.id) && proposal.requester_discord_id !== interaction.user.id) throw new Error("You are not permitted to review this proposal.");
	const sourceIds = proposal?.source_message_ids ?? [draft?.targetId ?? entityId];
	const workPackage = await createAndAnnounce({
		interaction,
		services,
		title: interaction.fields.getTextInputValue("title"),
		description: interaction.fields.getTextInputValue("description"),
		projectText: draft ? String(draft.projectId) : interaction.fields.getTextInputValue("project") || null,
		assigneeId: draft ? draft.assigneeId : interaction.fields.getTextInputValue("assignee") || undefined,
		startDate: draft ? interaction.fields.getTextInputValue("start_date") || undefined : undefined,
		dueDate: interaction.fields.getTextInputValue("due_date") || undefined,
		sourceLinks: sourceIds.map(id => messageUrl(interaction.guildId!, interaction.channelId!, id)),
	});
	if (draft) contextDrafts.delete(entityId);
	if (proposal) await services.db.markProposalCreated(proposal.id, interaction.user.id, workPackage.id);
}

export function registerTaskInteractions(client: Client, services: Services) {
	client.on("interactionCreate", async interaction => {
		try {
			if (interaction.isAutocomplete()) await handleAutocomplete(interaction, services);
			else if (interaction.isChatInputCommand()) await handleSlash(interaction, services);
			else if (interaction.isMessageContextMenuCommand()) {
				await handleContext(interaction, services);
				await handleAiContext(interaction, services);
			}
			else if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) await handleContextSelect(interaction);
			else if (interaction.isButton()) {
				if (!await handleContextContinue(interaction, services)) await handleProposalButton(interaction, services);
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
