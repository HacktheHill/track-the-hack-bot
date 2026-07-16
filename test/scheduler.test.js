import assert from "node:assert/strict";
import test from "node:test";
import { parseScheduleTime, scheduleCommand, scheduledMessageChoices, scheduledWebhookPayload } from "../dist/scheduler.js";

test("schedule timestamps require an explicit timezone and future time", () => {
	const now = new Date("2026-07-16T12:00:00Z");
	assert.equal(
		parseScheduleTime("2026-07-16T10:00:00-04:00", now).toISOString(),
		"2026-07-16T14:00:00.000Z",
	);
	assert.throws(() => parseScheduleTime("2026-07-16T14:00:00", now), /timezone/);
	assert.throws(() => parseScheduleTime("2027-02-30T14:00:00Z", now), /not valid/);
	assert.throws(() => parseScheduleTime("2026-07-16T08:00:00-04:00", now), /future/);
});

test("schedule timestamps support relative durations", () => {
	const now = new Date("2026-07-16T12:00:00Z");
	assert.equal(parseScheduleTime("2 hours", now).toISOString(), "2026-07-16T14:00:00.000Z");
	assert.equal(parseScheduleTime("in 30 minutes", now).toISOString(), "2026-07-16T12:30:00.000Z");
});

test("schedule timestamps support local calendar times", () => {
	const now = new Date("2026-07-16T12:00:00Z");
	assert.equal(
		parseScheduleTime("10am", now, "America/Toronto").toISOString(),
		"2026-07-16T14:00:00.000Z",
	);
	assert.equal(
		parseScheduleTime("10am", new Date("2026-07-16T16:00:00Z"), "America/Toronto").toISOString(),
		"2026-07-17T14:00:00.000Z",
	);
	assert.equal(
		parseScheduleTime("tomorrow 10am", now, "America/Toronto").toISOString(),
		"2026-07-17T14:00:00.000Z",
	);
	assert.equal(
		parseScheduleTime("today at 10:30", now, "America/Toronto").toISOString(),
		"2026-07-16T14:30:00.000Z",
	);
	assert.equal(
		parseScheduleTime("tomorrow 10am", new Date("2026-12-01T12:00:00Z"), "America/Toronto").toISOString(),
		"2026-12-02T15:00:00.000Z",
	);
	assert.throws(
		() => parseScheduleTime("tomorrow 2:30am", new Date("2026-03-07T12:00:00Z"), "America/Toronto"),
		/daylight-saving time change/,
	);
	assert.throws(() => parseScheduleTime("tomorrow 10:99am", now, "America/Toronto"), /not valid/);
});

test("scheduled webhook payload uses the saved scheduler identity", () => {
	const payload = scheduledWebhookPayload({
		id: "schedule",
		guildId: "guild",
		channelId: "channel",
		createdByDiscordId: "user",
		schedulerName: "Organizer Display Name",
		schedulerAvatarUrl: "https://cdn.discordapp.com/avatar.png",
		content: "Remember the meeting",
		sendAt: "2026-07-16T14:00:00Z",
		status: "processing",
		attempts: 1,
		error: null,
	});
	assert.equal(payload.username, "Organizer Display Name");
	assert.equal(payload.avatarURL, "https://cdn.discordapp.com/avatar.png");
	assert.equal(payload.content, "Remember the meeting");
	assert.deepEqual(payload.allowedMentions.parse, ["users", "roles"]);
});

test("scheduled message cancellation uses selectable message choices", () => {
	const choices = scheduledMessageChoices([
		{
			id: "internal-id", guildId: "guild", channelId: "channel", createdByDiscordId: "user",
			schedulerName: "Name", schedulerAvatarUrl: null, content: "Send the reminder", sendAt: "2026-07-17T14:00:00Z",
			status: "pending", attempts: 0, error: null,
		},
	], "reminder", "America/Toronto");
	assert.equal(choices.length, 1);
	assert.match(choices[0].name, /Send the reminder/);
	assert.doesNotMatch(choices[0].name, /internal-id/);
	assert.equal(choices[0].value, "internal-id");
});

test("schedule command supports create, list, and cancel", () => {
	const command = scheduleCommand.toJSON();
	assert.deepEqual(command.options.map(option => option.name), ["create", "list", "cancel"]);
	const create = command.options.find(option => option.name === "create");
	assert.equal(create.options.find(option => option.name === "at").required, true);
	assert.equal(create.options.find(option => option.name === "message").max_length, 2000);
	const cancel = command.options.find(option => option.name === "cancel");
	assert.equal(cancel.options[0].name, "message");
	assert.equal(cancel.options[0].autocomplete, true);
});
