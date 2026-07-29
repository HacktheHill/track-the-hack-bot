import { ChannelType, type Guild, type GuildMember } from "discord.js";

export type ProjectReference = { id: number; name: string };

async function guildChannel(guild: Guild, channelId: string) {
	return guild.channels.cache?.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
}

export function normalizeProjectName(value: string) {
	return value
		.normalize("NFKC")
		.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D]/gu, " ")
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLocaleLowerCase();
}

export function projectIdForName(name: string | null | undefined, projects: readonly ProjectReference[]) {
	if (!name) return undefined;
	const normalized = normalizeProjectName(name);
	if (!normalized) return undefined;
	const matches = projects.filter(project => normalizeProjectName(project.name) === normalized);
	return matches.length === 1 ? matches[0].id : undefined;
}

export function projectIdForTeamRoles(member: GuildMember | null | undefined, mappings: Record<string, { projectId: number }>) {
	if (!member) return undefined;
	const projectIds = new Set(Object.entries(mappings)
		.filter(([roleId]) => member.roles.cache.has(roleId))
		.map(([, mapping]) => mapping.projectId));
	return projectIds.size === 1 ? [...projectIds][0] : undefined;
}

export function projectIdForProposedOwner(
	assignee: GuildMember | null | undefined,
	explicitAccountable: GuildMember | null | undefined,
	mappings: Record<string, { projectId: number }>,
) {
	return projectIdForTeamRoles(assignee ?? explicitAccountable, mappings);
}

export async function projectIdFromChannelNames(channelId: string, guild: Guild, projects: readonly ProjectReference[]) {
	let channel = await guildChannel(guild, channelId);
	if (channel?.isThread()) channel = channel.parentId ? await guildChannel(guild, channel.parentId) : null;
	if (!channel) return undefined;

	if (channel.type !== ChannelType.GuildCategory) {
		const channelProjectId = projectIdForName(channel.name, projects);
		if (channelProjectId) return channelProjectId;
	}

	for (let depth = 0; channel && depth < 5; depth++) {
		if (channel.type === ChannelType.GuildCategory) return projectIdForName(channel.name, projects);
		if (!channel.parentId) break;
		channel = await guildChannel(guild, channel.parentId);
	}
	return undefined;
}

export async function resolveProjectId(
	channelId: string,
	guild: Guild,
	projects: readonly ProjectReference[],
	options: { teamProjectId?: number; inferredProjectName?: string | null } = {},
) {
	const activeTeamProjectId = options.teamProjectId && projects.some(project => project.id === options.teamProjectId)
		? options.teamProjectId
		: undefined;
	return await projectIdFromChannelNames(channelId, guild, projects)
		?? activeTeamProjectId
		?? projectIdForName(options.inferredProjectName, projects);
}

export async function isExcludedChannel(channelId: string, guild: Guild, excludedIds: ReadonlySet<string>) {
	let channel = await guildChannel(guild, channelId);
	if (!channel) return true;
	for (let depth = 0; channel && depth < 5; depth++) {
		if (excludedIds.has(channel.id)) return true;
		if (!channel.parentId) break;
		channel = await guildChannel(guild, channel.parentId);
		if (!channel) return true;
	}
	return false;
}
