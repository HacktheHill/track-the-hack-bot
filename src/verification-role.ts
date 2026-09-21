import type { Client, GuildMember } from "discord.js";

export async function grantVerifiedHackerRole(
	client: Pick<Client, "guilds">,
	guildId: string,
	roleId: string,
	discordId: string,
	onAdded: (member: GuildMember) => Promise<void>,
) {
	const guild = await client.guilds.fetch(guildId);
	const member = await guild.members.fetch(discordId);
	const role = await guild.roles.fetch(roleId);
	if (!role) throw new Error("Hacker role unavailable");
	if (member.roles.cache.has(role.id)) return;
	await member.roles.add(role);
	await onAdded(member);
}
