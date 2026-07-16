import assert from "node:assert/strict";
import test from "node:test";
import { AI_CONTEXT_GAP_MS, appendRelevantUrls, calendarDate, databaseDate, dateChoices, defaultAiDueDate, defaultTaskDates, explicitAssignmentNames, followingUntilGap, precedingUntilGap, taskCommand, validIsoDate } from "../dist/tasks.js";
import { normalizeTaskTitle, OpenProjectClient, titlesLikelyDuplicate } from "../dist/openproject.js";

test("task defaults start today and use the configured due offset", () => {
	assert.deepEqual(defaultTaskDates(new Date("2026-07-13T23:30:00Z"), true, 7), {
		startDate: "2026-07-13",
		dueDate: "2026-07-20",
	});
	assert.equal(defaultTaskDates(new Date("2026-07-13T00:00:00Z"), false, 0).startDate, undefined);
});

test("Today and Tomorrow use Eastern Time rather than UTC", () => {
	const afterMidnightUtc = new Date("2026-07-14T02:00:00Z");
	assert.equal(calendarDate(afterMidnightUtc, "America/Toronto"), "2026-07-13");
	assert.deepEqual(defaultTaskDates(afterMidnightUtc, true, 1, "America/Toronto"), {
		startDate: "2026-07-13",
		dueDate: "2026-07-14",
	});
});

test("start-date choices include nearby past dates", () => {
	const choices = dateChoices("", true, new Date("2026-07-14T16:00:00Z"), "America/Toronto");
	assert.deepEqual(choices.slice(0, 5).map(choice => choice.value), [
		"2026-07-14", "2026-07-13", "2026-07-15", "2026-07-12", "2026-07-16",
	]);
	assert.match(choices[1].name, /^Yesterday/);
	assert.equal(dateChoices("", false, new Date("2026-07-14T16:00:00Z"), "America/Toronto").some(choice => choice.value < "2026-07-14"), false);
});

test("date validation rejects invalid or non-ISO dates", () => {
	assert.equal(validIsoDate("2026-07-13"), "2026-07-13");
	assert.throws(() => validIsoDate("07/13/2026"), /YYYY-MM-DD/);
	assert.throws(() => validIsoDate("2026-02-30"), /YYYY-MM-DD/);
});

test("database dates render as ISO values in review modals", () => {
	assert.equal(databaseDate(new Date("2026-07-28T00:00:00Z")), "2026-07-28");
	assert.equal(databaseDate("2026-07-28"), "2026-07-28");
});

test("AI deadlines scale with priority and size", () => {
	const now = new Date("2026-07-14T20:00:00Z");
	assert.equal(defaultAiDueDate(now), "2026-07-28");
	assert.equal(defaultAiDueDate(now, "High", "🦑 Large"), "2026-08-04");
	assert.equal(defaultAiDueDate(now, "Immediate", "🐇 Small"), "2026-07-17");
	assert.equal(defaultAiDueDate(now, "Low", "🐋 X-Large"), "2026-09-01");
});

test("assignment labels identify responsible people", () => {
	assert.deepEqual(explicitAssignmentNames("Task 3 (Alex): prepare the planning document"), ["Alex"]);
	assert.deepEqual(explicitAssignmentNames("Assignee: Sam\nPrepare the report"), ["Sam"]);
});

test("AI context stops at a significant inter-message time gap", () => {
	const target = Date.parse("2026-07-06T21:59:00Z");
	const nearby = { id: "nearby", createdTimestamp: target - 9 * 60_000 };
	const followup = { id: "followup", createdTimestamp: target + 9 * 60_000 };
	const oldTopic = { id: "old-topic", createdTimestamp: Date.parse("2024-09-27T18:13:00Z") };
	assert.equal(AI_CONTEXT_GAP_MS, 30 * 60_000);
	assert.deepEqual(precedingUntilGap(target, [oldTopic, nearby]).map(message => message.id), ["nearby"]);
	assert.deepEqual(followingUntilGap(target, [followup, { id: "later", createdTimestamp: target + 2 * AI_CONTEXT_GAP_MS }]).map(message => message.id), ["followup"]);
});

test("AI task descriptions retain URLs from cited messages", () => {
	const description = appendRelevantUrls("Create the outreach tracker.", [
		{ id: "primary", authorAlias: "USER_1", text: "Create a spreadsheet", timestamp: "2026-07-06T21:50:00Z" },
		{ id: "followup", authorAlias: "USER_2", text: "Created: https://docs.google.com/spreadsheets/d/example", timestamp: "2026-07-06T21:59:00Z" },
	], ["primary", "followup"]);
	assert.match(description, /Related links:/);
	assert.match(description, /https:\/\/docs\.google\.com\/spreadsheets\/d\/example/);
});

test("task creation exposes selectable fields and keeps description optional", () => {
	const create = taskCommand.toJSON().options.find(option => option.name === "create");
	const options = create.options;
	assert.equal(options.find(option => option.name === "description").required, false);
	assert.equal(options.find(option => option.name === "priority").autocomplete, true);
	assert.equal(options.find(option => option.name === "size").autocomplete, true);
	assert.equal(options.find(option => option.name === "start_date").autocomplete, true);
	assert.equal(options.find(option => option.name === "due_date").autocomplete, true);
	assert.equal(options.some(option => option.name === "story_points"), false);
	assert.equal(taskCommand.toJSON().options.some(option => option.name === "configure-category"), true);
});

test("duplicate detection normalizes punctuation and compares meaningful words", () => {
	assert.equal(normalizeTaskTitle("  Ship: Sponsor Portal! "), "ship sponsor portal");
	assert.equal(titlesLikelyDuplicate("Ship the sponsor portal", "Sponsor portal: ship implementation"), true);
	assert.equal(titlesLikelyDuplicate("Book venue", "Update Discord roles"), false);
});

test("OpenProject creation uses dynamic type/size metadata and appends Discord context", async () => {
	const calls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init = {}) => {
		calls.push({ url: String(url), init });
		if (String(url).endsWith("/form")) return new Response(JSON.stringify({
			_embedded: { validationErrors: {}, payload: { customField2: "Small" } },
		}), { status: 200 });
		return new Response(JSON.stringify({ id: 42, subject: "Ship portal", lockVersion: 1, _links: {} }), { status: 200 });
	};
	try {
		const client = new OpenProjectClient({
			OPENPROJECT_BASE_URL: "https://project.example", OPENPROJECT_API_KEY: "test",
			OPENPROJECT_SIZE_CUSTOM_FIELD: "customField2",
		});
		await client.createWorkPackage({
			projectId: 3, subject: "Ship portal", description: "Complete it", typeId: 9,
			sizeHref: "/api/v3/custom_options/7", sourceLinks: ["https://discord.com/channels/1/2/3"],
		});
		const formPayload = JSON.parse(calls[0].init.body);
		const commitPayload = JSON.parse(calls[1].init.body);
		assert.equal(formPayload._links.type.href, "/api/v3/types/9");
		assert.equal(commitPayload.customField2.href, "/api/v3/custom_options/7");
		assert.match(formPayload.description.raw, /discord\.com\/channels\/1\/2\/3/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("OpenProject project membership checks the mapped principal", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({
		_embedded: {
			elements: [
				{ id: 17, name: "Invited Member", status: "invited", _type: "User" },
			],
		},
	}), { status: 200 });
	try {
		const client = new OpenProjectClient({
			OPENPROJECT_BASE_URL: "https://project.example",
			OPENPROJECT_API_KEY: "test",
			OPENPROJECT_CACHE_TTL_MS: 300000,
		});
		assert.equal(await client.isProjectMember(3, 17), true);
		assert.equal(await client.isProjectMember(3, 18), false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
