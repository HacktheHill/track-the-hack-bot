import assert from "node:assert/strict";
import test from "node:test";
import { isOrganizerGuild, loadIntegrationConfig, loadOutreachConfig } from "../dist/config.js";

test("AI review automation remains disabled by default", () => {
	const previous = { ...process.env };
	Object.assign(process.env, {
		OPENPROJECT_BASE_URL: "https://project.example",
		OPENPROJECT_API_KEY: "test",
		DATABASE_URL: "postgresql://localhost/test",
		ORGANIZER_GUILD_ID: "1",
		ORGANIZER_GUILD_MEMBER_ROLE_ID: "2",
		ORGANIZER_GUILD_ORGANIZER_ROLE_ID: "3",
	});
	delete process.env.OPENPROJECT_AUTOMATION_MODE;
	delete process.env.OPENPROJECT_RUN_MIGRATIONS;
	try {
		const config = loadIntegrationConfig();
		assert.equal(config?.OPENPROJECT_AUTOMATION_MODE, "off");
		assert.equal(config?.OPENPROJECT_DRAFT_TTL_MINUTES, 1440);
		assert.equal(config?.OPENPROJECT_RUN_MIGRATIONS, false);
		assert.equal(config?.BOT_TIME_ZONE, "America/Toronto");
		assert.equal("aiChannels" in config, false);
	} finally {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, previous);
	}
});

test("OpenProject features are restricted to the configured Organizer guild", () => {
	const config = { ORGANIZER_GUILD_ID: "organizer" };
	assert.equal(isOrganizerGuild(config, "organizer"), true);
	assert.equal(isOrganizerGuild(config, "community"), false);
	assert.equal(isOrganizerGuild(config, null), false);
});

test("excluded channel configuration merges legacy blocks and category exclusions", () => {
	const previous = { ...process.env };
	Object.assign(process.env, {
		OPENPROJECT_BASE_URL: "https://project.example",
		OPENPROJECT_API_KEY: "test",
		DATABASE_URL: "postgresql://localhost/test",
		ORGANIZER_GUILD_ID: "1",
		ORGANIZER_GUILD_MEMBER_ROLE_ID: "2",
		ORGANIZER_GUILD_ORGANIZER_ROLE_ID: "3",
		OPENPROJECT_BLOCKED_CHANNEL_IDS: '["blocked"]',
		OPENPROJECT_EXCLUDED_CHANNEL_IDS: '["external-category","other-channel"]',
	});
	try {
		const config = loadIntegrationConfig();
		assert.deepEqual([...config.excludedChannelIds].sort(), ["blocked", "external-category", "other-channel"]);
	} finally {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, previous);
	}
});

test("outreach integration is disabled only when all dedicated settings are absent", () => {
	const previous = { ...process.env };
	for (const key of Object.keys(process.env)) delete process.env[key];
	try {
		assert.equal(loadOutreachConfig(), null);
		process.env.OUTREACH_SERVICE_URL = "https://outreach.internal.example";
		assert.throws(() => loadOutreachConfig(), /incomplete/);
	} finally {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, previous);
	}
});

test("outreach configuration validates HTTPS, secret strength, and channel IDs", () => {
	const previous = { ...process.env };
	Object.assign(process.env, {
		OUTREACH_SERVICE_URL: "https://outreach.internal.example",
		OUTREACH_DISCORD_KEY_ID: "key-1",
		OUTREACH_DISCORD_SIGNING_SECRET: "s".repeat(32),
		OUTREACH_DISCORD_ALLOWED_CHANNEL_IDS: '["1234567891"]',
		ORGANIZER_GUILD_ID: "1234567890",
		ORGANIZER_GUILD_ORGANIZER_ROLE_ID: "1234567892",
	});
	try {
		const config = loadOutreachConfig();
		assert.equal(config.allowedChannelIds.has("1234567891"), true);
		process.env.OUTREACH_SERVICE_URL = "http://outreach.internal.example";
		assert.throws(() => loadOutreachConfig());
		process.env.OUTREACH_SERVICE_URL = "https://outreach.internal.example";
		process.env.OUTREACH_DISCORD_SIGNING_SECRET = "short";
		assert.throws(() => loadOutreachConfig());
		process.env.OUTREACH_DISCORD_SIGNING_SECRET = "s".repeat(32);
		process.env.OUTREACH_DISCORD_ALLOWED_CHANNEL_IDS = '"not-an-array"';
		assert.throws(() => loadOutreachConfig(), /must contain Discord channel IDs/);
		process.env.OUTREACH_DISCORD_ALLOWED_CHANNEL_IDS = '["invalid"]';
		assert.throws(() => loadOutreachConfig(), /must contain Discord channel IDs/);
	} finally {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, previous);
	}
});
