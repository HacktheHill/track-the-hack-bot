# AI extraction evaluation

The private evaluation corpus and case-level reports are excluded from source
control. Commit only aggregate results; never commit Discord message text,
participant identifiers, or per-case model output.

## Current schema v3

Automatic evaluation mirrors the production two-stage pipeline. The first model
call extracts recall-oriented candidates. The second independently assesses each
candidate for activated specific work, remaining work or a trackable transition,
durability, decision readiness, contextual sensitivity, and supporting source
message IDs. A candidate is eligible only when every positive criterion passes,
the sensitivity result is `safe`, and its support is grounded in the bounded
input.

Use `npm run evaluate:ai -- /secure/path/corpus.jsonl` for a private JSONL corpus
and `npm run replay:ai -- 2,4,5` for retained production events. Reports include
stage-level latency, token usage, validity, proposal precision/recall, owner and
deadline accuracy, and routing outcomes. Keep independently adjudicated v3 cases
outside source control. Legacy events and corpora that contain extraction-time
`automatic_eligibility`, `trigger_kind`, or `lifecycle` labels are not directly
comparable to v3 gate results.

Run these commands from a host that can reach the Azure OpenAI resource's private
endpoint. If no valid model output is produced, the report marks quality metrics
as `N/A` and lists sanitized provider error categories. Deterministic client and
access failures such as HTTP 403 and 404 are not retried; throttling, transient
server failures, timeouts, and network failures use the configured retry budget.

## Review-derived corpus

Proposal reviews collected after the current database migration can be exported
without manually writing JSONL:

```bash
npm run export:ai-corpus -- .private/reviewed-corpus.jsonl 90
```

The optional final argument is the lookback in days. The command writes a
mode-0600 file and prints counts only; run it in the private Container Apps
environment where `DATABASE_URL` is available. It pseudonymizes message and
attachment IDs, removes live attachment URLs, and evaluates every exported case
in automatic mode. In particular, an accepted manual extraction means that the
automatic pipeline should find the work in that context.

Approved proposals use their final reviewed title, action, source messages, and
target semantics. Dismissals labeled `not_actionable`,
`question_or_announcement`, `already_completed`, or `not_worth_tracking` become
negative cases. Sensitive overrides, sensitive/private dismissals, duplicates,
ambiguous reasons, pending reviews, and incorrect proposals without a corrected
expected result are excluded. Reviewer retargeting, source-lineage action
conversion, incomplete final snapshots, source IDs absent from the exact input,
superseded extraction links, and multi-candidate manual extractions are also
excluded rather than assigned potentially incorrect labels. The
generated corpus therefore provides useful decision, source-grounding, and
routing coverage, but owner/deadline labels still require deliberate enrichment
and randomly sampled `no_task` windows still need human review for an unbiased
recall estimate.

## 2026-07-17 baseline

- Model deployment: `task-extractor`
- Corpus: 100 pseudonymized windows
- Composition: 13 production telemetry windows and 87 reviewed synthetic
  scenario windows
- Task precision: 100.0% (target 95%)
- Task recall: 100.0%
- False-positive rate: 0.0%
- Owner accuracy: 100.0% (target 90%)
- Deadline accuracy: 100.0% (target 90%)
- Valid structured output: 100.0% (target 99%)
- Average model latency: 1,410 ms
- Total tokens: 132,665
- Provider retries/errors: 0/0

This baseline validates the evaluation pipeline and its current known
scenarios. It is not a fully independent production-quality estimate: the 13
production windows use stored model telemetry labels and the remaining windows
are synthetic. Continue collecting human review outcomes and replace synthetic
cases with independently annotated, representative production windows over
time. AI remains limited to human-reviewed proposals and cannot create an
OpenProject task without reviewer approval.

Retained minimized production windows can be replayed read-only from a runtime
with database and Azure managed-identity access:

```bash
npm run replay:ai -- 2,4,5,6
```

The command prints candidate titles, actions, gate eligibility, gate criteria,
and cited supporting message IDs. It does not print retained message text or
modify proposal and extraction records. New events replay the exact bounded
minimized input and planning options selected for Azure, except locally blocked
sensitive contexts, whose text is intentionally not retained. Older events are marked
`legacy_text_snapshot` because attachment, reply, and planning metadata may not
have been retained. Replays wait eight seconds between requests by default;
`AI_REPLAY_MIN_INTERVAL_MS` can override that pacing for a deployment with a
different rate limit.

The successful run used an eight-second minimum interval between provider
requests. Set `AI_EVAL_MIN_INTERVAL_MS` and `AI_EVAL_PROVIDER_RETRIES` for
future batch runs when the Azure deployment has limited request or token
capacity.
