import assert from "node:assert/strict";
import test from "node:test";
import { matchOpenProjectIdentity, normalizedName } from "../dist/identity.js";

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
