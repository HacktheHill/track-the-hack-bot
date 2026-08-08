import assert from "node:assert/strict";
import test from "node:test";
import { matchOpenProjectIdentity, normalizedName, reconcileOpenProjectUsers, resolveOpenProjectIdentity } from "../dist/identity.js";

const users = [
	{ id: 174, name: "Maria Chorna Kyba", status: "invited" },
	{ id: 178, name: "Maria Martiyanova", status: "invited" },
	{ id: 180, name: "Julie Tremblay", status: "active" },
];
const groups = new Map([
	[23, new Set([178])],
	[26, new Set([174])],
]);

test("identity matching normalizes whitespace, punctuation, and team suffixes", () => {
	assert.equal(normalizedName("  María\tMartiyanova "), "maria martiyanova");
	assert.equal(matchOpenProjectIdentity({ id: "1", displayName: "Maria K [Partnerships]", teamGroupIds: [26] }, users, groups)?.user.id, 174);
});

test("team membership disambiguates duplicate first names", () => {
	const logistics = matchOpenProjectIdentity({ id: "2", displayName: "Maria [Logistics]", teamGroupIds: [23] }, users, groups);
	assert.deepEqual({ id: logistics?.user.id, reason: logistics?.reason }, { id: 178, reason: "team" });
});

test("ambiguous first names are never linked automatically", () => {
	assert.equal(matchOpenProjectIdentity({ id: "3", displayName: "Maria", teamGroupIds: [] }, users, groups), undefined);
	assert.equal(matchOpenProjectIdentity({ id: "4", displayName: "Julie [Community]", teamGroupIds: [] }, users, groups)?.user.id, 180);
});

test("a unique alternate Discord name can resolve an ambiguous guild nickname", () => {
	const ambiguousTeamGroups = new Map([[26, new Set([174, 178])]]);
	const match = matchOpenProjectIdentity({
		id: "5",
		displayName: "Maria",
		alternateNames: ["Maria K"],
		teamGroupIds: [26],
	}, users, ambiguousTeamGroups);
	assert.deepEqual({ id: match?.user.id, reason: match?.reason }, { id: 174, reason: "last_initial" });
	assert.equal(matchOpenProjectIdentity({
		id: "6",
		displayName: "Maria",
		alternateNames: ["Maria K", "Maria M"],
		teamGroupIds: [],
	}, users, groups), undefined);
});

function member(id, displayName, roles = []) {
	return { id, displayName, user: { bot: false, globalName: null, username: displayName }, roles: { cache: { has: role => roles.includes(role) } } };
}

test("on-demand identity resolution uses an existing mapping without fetching Discord or OpenProject", async () => {
	const resolution = await resolveOpenProjectIdentity("discord-1", {
		members: { fetch: async () => { throw new Error("should not fetch"); } },
	}, { teamRoles: {} }, {
		openProjectUserId: async () => 91,
	}, {
		linkableUsers: async () => { throw new Error("should not load catalog"); },
	});
	assert.deepEqual(resolution, { openProjectId: 91 });
});

test("on-demand identity resolution fetches uncached members and persists only collision-free matches", async () => {
	const fetched = [];
	const saved = [];
	const guild = { members: { fetch: async id => {
		fetched.push(id);
		return member(id, "Invited Person");
	} } };
	const db = {
		openProjectUserId: async () => undefined,
		openProjectUserMappings: async () => new Map(),
		claimOpenProjectUser: async (...mapping) => { saved.push(mapping); return true; },
	};
	const openProject = {
		linkableUsers: async () => [{ id: 22, name: "Invited Person", status: "invited", _type: "User" }],
		groupUserIds: async () => [],
	};
	assert.equal((await resolveOpenProjectIdentity("discord-2", guild, { teamRoles: {} }, db, openProject)).openProjectId, 22);
	assert.deepEqual(fetched, ["discord-2"]);
	assert.deepEqual(saved, [["discord-2", 22]]);

	db.openProjectUserMappings = async () => new Map([["other-discord", 22]]);
	const collision = await resolveOpenProjectIdentity("discord-3", guild, { teamRoles: {} }, db, openProject);
	assert.equal(collision.problem, "collision");
	assert.deepEqual(saved, [["discord-2", 22]]);
});

test("automatic reconciliation catalogs invited users outside project assignee lists", async () => {
	const organizer = member("discord-4", "Invite Only", ["member-role"]);
	const saved = [];
	const result = await reconcileOpenProjectUsers({
		members: { fetch: async () => new Map([[organizer.id, organizer]]) },
	}, {
		ORGANIZER_GUILD_MEMBER_ROLE_ID: "member-role",
		teamRoles: {},
	}, {
		openProjectUserMappings: async () => new Map(),
		claimOpenProjectUser: async (...mapping) => { saved.push(mapping); return true; },
	}, {
		linkableUsers: async () => [{ id: 23, name: "Invite Only", status: "invited", _type: "User" }],
		groupUserIds: async () => [],
		users: async () => { throw new Error("project assignee catalog must not be used"); },
	});
	assert.deepEqual(saved, [["discord-4", 23]]);
	assert.deepEqual(result, { linked: 1, ambiguous: 0, totalMappings: 1 });
});
