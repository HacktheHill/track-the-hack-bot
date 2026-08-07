import type { Guild, GuildMember } from "discord.js";
import type { IntegrationConfig } from "./config.js";
import type { Database } from "./database.js";
import type { OpenProjectClient, OpenProjectUser } from "./openproject.js";

export type DiscordIdentity = { id: string; displayName: string; teamGroupIds: number[] };
export type IdentityMatch = { user: OpenProjectUser; reason: "exact_name" | "last_initial" | "team" | "unique_first_name" };
export type IdentityResolution = {
	openProjectId?: number;
	match?: IdentityMatch;
	problem?: "member_unavailable" | "ambiguous_or_unmapped" | "collision";
};

export function normalizedName(value: string) {
	return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function discordNameParts(displayName: string) {
	const withoutTeams = displayName.replace(/(?:\s*\[[^\]]+\])+\s*$/g, "");
	return normalizedName(withoutTeams).split(" ").filter(Boolean);
}

export function matchOpenProjectIdentity(
	identity: DiscordIdentity,
	users: OpenProjectUser[],
	groupUsers: Map<number, Set<number>>,
): IdentityMatch | undefined {
	const discordParts = discordNameParts(identity.displayName);
	if (!discordParts.length) return undefined;
	const candidates = users.filter(user => normalizedName(user.name).split(" ")[0] === discordParts[0]);
	if (!candidates.length) return undefined;

	const exact = candidates.filter(user => normalizedName(user.name) === discordParts.join(" "));
	if (exact.length === 1) return { user: exact[0], reason: "exact_name" };

	const teamCandidates = identity.teamGroupIds.length
		? candidates.filter(user => identity.teamGroupIds.some(groupId => groupUsers.get(groupId)?.has(user.id)))
		: [];
	const scoped = identity.teamGroupIds.length ? teamCandidates : candidates;
	if (discordParts.length >= 2) {
		const initial = discordParts.at(-1)![0];
		const initialMatches = scoped.filter(user => normalizedName(user.name).split(" ").slice(1).some(part => part.startsWith(initial)));
		if (initialMatches.length === 1) return { user: initialMatches[0], reason: "last_initial" };
	}
	if (teamCandidates.length === 1) return { user: teamCandidates[0], reason: "team" };
	if (!identity.teamGroupIds.length && candidates.length === 1) return { user: candidates[0], reason: "unique_first_name" };
	return undefined;
}

function teamGroupIds(member: GuildMember, config: IntegrationConfig) {
	return Object.entries(config.teamRoles).flatMap(([roleId, mapping]) =>
		member.roles.cache.has(roleId) && mapping.openProjectGroupId ? [mapping.openProjectGroupId] : [],
	);
}

async function identityCatalog(config: IntegrationConfig, openProject: OpenProjectClient) {
	const users = await openProject.linkableUsers();
	const groupIds = [...new Set(Object.values(config.teamRoles).flatMap(mapping => mapping.openProjectGroupId ? [mapping.openProjectGroupId] : []))];
	const groupUsers = new Map<number, Set<number>>();
	await Promise.all(groupIds.map(async groupId => groupUsers.set(groupId, new Set(await openProject.groupUserIds(groupId)))));
	return { users, groupUsers };
}

export async function resolveOpenProjectIdentity(
	discordId: string,
	guild: Guild,
	config: IntegrationConfig,
	db: Database,
	openProject: OpenProjectClient,
): Promise<IdentityResolution> {
	const mapped = await db.openProjectUserId(discordId);
	if (mapped) return { openProjectId: mapped };
	const member = await guild.members.fetch(discordId).catch(() => null);
	if (!member || member.user.bot) return { problem: "member_unavailable" };
	const [{ users, groupUsers }, existing] = await Promise.all([
		identityCatalog(config, openProject),
		db.openProjectUserMappings(),
	]);
	const match = matchOpenProjectIdentity({
		id: member.id,
		displayName: member.displayName,
		teamGroupIds: teamGroupIds(member, config),
	}, users, groupUsers);
	if (!match) return { problem: "ambiguous_or_unmapped" };
	if ([...existing].some(([mappedDiscordId, openProjectId]) => mappedDiscordId !== discordId && openProjectId === match.user.id)) {
		return { match, problem: "collision" };
	}
	if (!await db.claimOpenProjectUser(discordId, match.user.id)) return { match, problem: "collision" };
	return { openProjectId: match.user.id, match };
}

export async function reconcileOpenProjectUsers(
	guild: Guild,
	config: IntegrationConfig,
	db: Database,
	openProject: OpenProjectClient,
) {
	const [members, catalog, existing] = await Promise.all([
		guild.members.fetch(),
		identityCatalog(config, openProject),
		db.openProjectUserMappings(),
	]);
	const { users, groupUsers } = catalog;
	const usedOpenProjectIds = new Set(existing.values());
	let linked = 0;
	let ambiguous = 0;
	for (const member of members.values()) {
		if (member.user.bot || !member.roles.cache.has(config.ORGANIZER_GUILD_MEMBER_ROLE_ID) || existing.has(member.id)) continue;
		const match = matchOpenProjectIdentity({ id: member.id, displayName: member.displayName, teamGroupIds: teamGroupIds(member, config) }, users, groupUsers);
		if (!match || usedOpenProjectIds.has(match.user.id)) {
			ambiguous++;
			continue;
		}
		if (!await db.claimOpenProjectUser(member.id, match.user.id)) {
			ambiguous++;
			continue;
		}
		existing.set(member.id, match.user.id);
		usedOpenProjectIds.add(match.user.id);
		linked++;
	}
	return { linked, ambiguous, totalMappings: existing.size };
}
