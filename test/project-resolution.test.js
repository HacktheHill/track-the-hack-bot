import assert from "node:assert/strict";
import test from "node:test";
import { ChannelType } from "discord.js";
import { isExcludedChannel, normalizeProjectName, projectIdForName, projectIdForProposedOwner, projectIdForTeamRoles, projectIdFromChannelNames, resolveProjectId } from "../dist/project-resolution.js";

const channel = (id, name, parentId = null, type = ChannelType.GuildText) => ({
	id, name, parentId, type, isThread: () => false,
});

test("project names ignore Discord emoji, separators, whitespace, and case", () => {
	assert.equal(normalizeProjectName("  Communications-Team 📢 "), "communications team");
	assert.equal(projectIdForName("community_team 🎭", [{ id: 7, name: "Community Team" }]), 7);
	assert.equal(projectIdForName("General", [{ id: 1, name: "General" }, { id: 2, name: "general" }]), undefined);
});

test("channel names take precedence over category names", async () => {
	const channels = new Map([
		["officers", channel("officers", "Officers 💼", null, ChannelType.GuildCategory)],
		["secretariat", channel("secretariat", "secretariat", "officers")],
	]);
	const guild = { channels: { fetch: async id => channels.get(id) ?? null } };
	const projects = [{ id: 10, name: "Officers" }, { id: 20, name: "Secretariat" }];
	assert.equal(await projectIdFromChannelNames("secretariat", guild, projects), 20);
	assert.equal(await resolveProjectId("secretariat", guild, projects, { teamProjectId: 10, inferredProjectName: "Officers" }), 20);
});

test("content inference is used only when channel and category names do not match", async () => {
	const channels = new Map([
		["headquarters", channel("headquarters", "Headquarters 🏠", null, ChannelType.GuildCategory)],
		["general", channel("general", "general", "headquarters")],
	]);
	const guild = { channels: { fetch: async id => channels.get(id) ?? null } };
	assert.equal(await resolveProjectId("general", guild, [{ id: 7, name: "Community Team" }], { inferredProjectName: "Community Team" }), 7);
	assert.equal(await resolveProjectId("general", guild, [{ id: 7, name: "Community Team" }]), undefined);
});

test("one distinct team project beats content inference while ambiguous teams abstain", async () => {
	const member = roleIds => ({ roles: { cache: { has: roleId => roleIds.includes(roleId) } } });
	const mappings = { logistics: { projectId: 7 }, logisticsLead: { projectId: 7 }, communications: { projectId: 8 } };
	assert.equal(projectIdForTeamRoles(member(["logistics"]), mappings), 7);
	assert.equal(projectIdForTeamRoles(member(["logistics", "logisticsLead"]), mappings), 7);
	assert.equal(projectIdForTeamRoles(member(["logistics", "communications"]), mappings), undefined);
	assert.equal(projectIdForProposedOwner(null, member(["communications"]), mappings), 8);
	assert.equal(projectIdForProposedOwner(member(["logistics", "communications"]), member(["communications"]), mappings), undefined);

	const channels = new Map([
		["headquarters", channel("headquarters", "Headquarters 🏠", null, ChannelType.GuildCategory)],
		["general", channel("general", "general", "headquarters")],
	]);
	const guild = { channels: { fetch: async id => channels.get(id) ?? null } };
	const projects = [{ id: 7, name: "Logistics" }, { id: 8, name: "Communications" }];
	assert.equal(await resolveProjectId("general", guild, projects, { teamProjectId: 7, inferredProjectName: "Communications" }), 7);
	assert.equal(await resolveProjectId("general", guild, projects, { teamProjectId: 99, inferredProjectName: "Communications" }), 8);
});

test("category names provide the fallback and threads inherit their parent channel", async () => {
	const channels = new Map([
		["community", channel("community", "Community Team 🎭", null, ChannelType.GuildCategory)],
		["planning", channel("planning", "planning", "community")],
		["thread", { ...channel("thread", "launch-discussion", "planning", ChannelType.PublicThread), isThread: () => true }],
	]);
	const guild = { channels: { fetch: async id => channels.get(id) ?? null } };
	assert.equal(await projectIdFromChannelNames("thread", guild, [{ id: 7, name: "Community Team" }]), 7);
});

test("excluded categories block all descendant channels and threads", async () => {
	const channels = new Map([
		["external", channel("external", "External 👥", null, ChannelType.GuildCategory)],
		["child", channel("child", "partners", "external")],
		["thread", { ...channel("thread", "discussion", "child", ChannelType.PublicThread), isThread: () => true }],
	]);
	const guild = { channels: { fetch: async id => channels.get(id) ?? null } };
	assert.equal(await isExcludedChannel("thread", guild, new Set(["external"])), true);
	assert.equal(await isExcludedChannel("missing", guild, new Set(["external"])), true);
});
