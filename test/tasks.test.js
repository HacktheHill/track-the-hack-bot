import assert from "node:assert/strict";
import test from "node:test";
import { defaultTaskDates, validIsoDate } from "../dist/tasks.js";
import { normalizeTaskTitle, OpenProjectClient, titlesLikelyDuplicate } from "../dist/openproject.js";

test("task defaults start today and use the configured due offset", () => {
	assert.deepEqual(defaultTaskDates(new Date("2026-07-13T23:30:00Z"), true, 7), {
		startDate: "2026-07-13",
		dueDate: "2026-07-20",
	});
	assert.equal(defaultTaskDates(new Date("2026-07-13T00:00:00Z"), false, 0).startDate, undefined);
});

test("date validation rejects invalid or non-ISO dates", () => {
	assert.equal(validIsoDate("2026-07-13"), "2026-07-13");
	assert.throws(() => validIsoDate("07/13/2026"), /YYYY-MM-DD/);
	assert.throws(() => validIsoDate("2026-02-30"), /YYYY-MM-DD/);
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
		if (String(url).endsWith("/form")) return new Response(JSON.stringify({ _embedded: { validationErrors: {} } }), { status: 200 });
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
		const payload = JSON.parse(calls[0].init.body);
		assert.equal(payload._links.type.href, "/api/v3/types/9");
		assert.equal(payload.customField2.href, "/api/v3/custom_options/7");
		assert.match(payload.description.raw, /discord\.com\/channels\/1\/2\/3/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
