import assert from "node:assert/strict";
import test from "node:test";
import { buildCorpusWindow, evaluationTitleTerms } from "../dist/export-ai-corpus.js";

function reviewedRow(overrides = {}) {
	return {
		id: "42",
		source: "manual",
		input_snapshot: [{
			id: "discord-message", authorAlias: "Person A", text: "I will revise the sponsor deck.",
			timestamp: "2026-07-20T13:00:00.000Z", contextRole: "primary",
			attachments: [{ id: "discord-attachment", name: "draft.png", contentType: "image/png", url: "https://cdn.discordapp.com/private" }],
		}],
		message_assessments: null,
		decision: {
			groupedCount: 1,
			extractionMetadata: { priorities: ["Normal"], sizes: ["Small"] },
			candidateAssessments: [{ proposedAction: "create", sourceMessageIds: ["discord-message"], sensitivity: "safe" }],
		},
		proposals: [{
			status: "created", reviewOutcome: "approved", dismissalReason: null, action: "create",
			targetWorkPackageId: null, title: "Revise the sponsor deck", sourceMessageIds: ["discord-message"],
			initialSnapshot: { title: "Revise the sponsor deck", action: "create", sourceMessageIds: ["discord-message"] },
			finalSnapshot: { title: "Revise sponsor deck", action: "create", sourceMessageIds: ["discord-message"] },
		}],
		...overrides,
	};
}

test("reviewed proposals export as pseudonymized evaluation windows", () => {
	const window = buildCorpusWindow(reviewedRow());
	assert.equal(window.id, "review-42");
	assert.equal(window.mode, "automatic");
	assert.equal(window.messages[0].id, "m1");
	assert.equal(window.messages[0].attachments[0].id, "a1");
	assert.equal(window.messages[0].attachments[0].url, "https://example.invalid/attachment/a1");
	assert.deepEqual(window.expected.proposals[0], {
		action: "create", titleIncludes: ["sponsor", "deck"], sourceMessageIds: ["m1"],
	});
});

test("clear negative dismissals export while ambiguous and sensitive dismissals do not", () => {
	const dismissal = reason => reviewedRow({
		proposals: [{
			status: "dismissed", reviewOutcome: "dismissed", dismissalReason: reason, action: "create",
			targetWorkPackageId: null, title: "Upload reel", sourceMessageIds: ["discord-message"], initialSnapshot: null, finalSnapshot: null,
		}],
	});
	assert.deepEqual(buildCorpusWindow(dismissal("question_or_announcement")).expected.proposals, []);
	assert.equal(buildCorpusWindow(dismissal("incorrect_proposal")), undefined);
	assert.equal(buildCorpusWindow(dismissal("sensitive_or_private")), undefined);
	assert.equal(buildCorpusWindow(reviewedRow({ decision: { groupedCount: 1, extractionOptions: { allowSensitiveContent: true } } })), undefined);
});

test("title terms remove generic task verbs", () => {
	assert.deepEqual(evaluationTitleTerms("Create the volunteer scheduling guide"), ["volunteer", "scheduling", "guide"]);
});

test("mutable or partially grounded reviewed proposals are excluded", () => {
	const retargeted = reviewedRow();
	retargeted.proposals[0].initialSnapshot.action = "update";
	assert.equal(buildCorpusWindow(retargeted), undefined);

	const missingSource = reviewedRow();
	missingSource.proposals[0].finalSnapshot.sourceMessageIds = ["discord-message", "missing-message"];
	assert.equal(buildCorpusWindow(missingSource), undefined);

	const missingFinalReview = reviewedRow();
	missingFinalReview.proposals[0].finalSnapshot = null;
	assert.equal(buildCorpusWindow(missingFinalReview), undefined);
});

test("automatic events use their dedicated candidate assessments", () => {
	const automatic = reviewedRow({
		source: "automatic",
		message_assessments: [{ proposedAction: "create", sourceMessageIds: ["discord-message"], sensitivity: "safe" }],
		decision: { extractionMetadata: { priorities: ["Normal"] } },
	});
	assert.equal(buildCorpusWindow(automatic).expected.proposals.length, 1);
	automatic.message_assessments[0].sensitivity = "sensitive";
	assert.equal(buildCorpusWindow(automatic), undefined);
});
