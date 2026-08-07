import assert from "node:assert/strict";
import test from "node:test";
import { buildHelpEmbeds } from "../dist/help.js";

const limits = {
	title: 256,
	description: 4096,
	fieldName: 256,
	fieldValue: 1024,
	fields: 25,
	total: 6000,
};

function assertDiscordEmbedLimits(embed) {
	const data = embed.toJSON();
	assert.ok((data.title?.length ?? 0) <= limits.title);
	assert.ok((data.description?.length ?? 0) <= limits.description);
	assert.ok((data.fields?.length ?? 0) <= limits.fields);
	for (const field of data.fields ?? []) {
		assert.ok(field.name.length <= limits.fieldName);
		assert.ok(field.value.length <= limits.fieldValue);
	}
	const total = (data.title?.length ?? 0)
		+ (data.description?.length ?? 0)
		+ (data.footer?.text.length ?? 0)
		+ (data.author?.name.length ?? 0)
		+ (data.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);
	assert.ok(total <= limits.total, `embed has ${total} characters`);
	return total;
}

test("organizer help is current and every embed remains within Discord limits", () => {
	const embeds = buildHelpEmbeds({
		guildId: "organizer",
		organizerGuildId: "organizer",
		communityGuildId: "community",
		uptimeSeconds: 90061,
		serverCount: 2,
	});
	assert.ok(embeds.length <= 10);
	const aggregate = embeds.reduce((sum, embed) => sum + assertDiscordEmbedLimits(embed), 0);
	assert.ok(aggregate <= limits.total, `embed response has ${aggregate} characters`);
	const content = embeds.map(embed => JSON.stringify(embed.toJSON())).join("\n");
	assert.match(content, /\/task extract/);
	assert.match(content, /20 by default, up to 50/);
	assert.match(content, /YYYY-MM-DD/);
	assert.match(content, /configured start\/due defaults/);
	assert.match(content, /due-date autocomplete includes today through the next 30 days/);
});

test("community help stays scoped and within Discord limits", () => {
	const embeds = buildHelpEmbeds({
		guildId: "community",
		organizerGuildId: "organizer",
		communityGuildId: "community",
		uptimeSeconds: Number.MAX_SAFE_INTEGER,
		serverCount: Number.MAX_SAFE_INTEGER,
	});
	const aggregate = embeds.reduce((sum, embed) => sum + assertDiscordEmbedLimits(embed), 0);
	assert.ok(aggregate <= limits.total, `embed response has ${aggregate} characters`);
	const content = embeds.map(embed => JSON.stringify(embed.toJSON())).join("\n");
	assert.match(content, /\/verify/);
	assert.doesNotMatch(content, /\/task create/);
});
