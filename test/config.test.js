import assert from "node:assert/strict";
import test from "node:test";
import { isOrganizerGuild, loadIntegrationConfig } from "../dist/config.js";

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
