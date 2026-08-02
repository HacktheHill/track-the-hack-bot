# AI extraction evaluation

The private evaluation corpus and case-level reports are excluded from source
control. Commit only aggregate results; never commit Discord message text,
participant identifiers, or per-case model output.

## Current schema v3

Automatic evaluation mirrors the production two-stage pipeline. The first model
call extracts recall-oriented candidates. The second independently assesses each
candidate for activated specific work, remaining work or a trackable transition,
durability, decision readiness, contextual sensitivity, and supporting source
message IDs. It also classifies the sensitivity of the complete message window.
A candidate is eligible only when every positive criterion passes,
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

## Corpus review desk

The canonical corpus is stored as independently versioned case documents under
`cases/` in the private `ai-evaluation` Blob container. The production sync job
adds safe review-derived and sampled `no_task` cases as `pending`; it never
admits a sampled negative without an explicit safe whole-window assessment.
Review-derived windows retain only candidate source/support messages. Source
changes preserve notes but reset the case to `pending`; sensitive blocks,
sensitive overrides, and unsafe input are not synchronized.

Run the UI locally with an Azure identity that has **Storage Blob Data
Contributor** on the corpus account:

```bash
az login
AI_CORPUS_STORAGE_ACCOUNT_URL=https://tthbotcorpus51fa.blob.core.windows.net \
  npm run corpus:ui
```

The UI binds to loopback, uses a per-launch request token, validates `Host` and
`Origin`, applies a restrictive content security policy, and uses ETags to
prevent silent concurrent overwrites. Blob versioning and soft delete provide
recovery.

Review states have distinct meanings:

- `pending`: not part of evaluation;
- `included`: included in the immutable snapshot referenced by
  `exports/current-manifest.json`; and
- `excluded`: invalid corpus material retained with one or more structured
  exclusion reasons, not a negative example.

To label a valid negative scenario, include it with an empty expected proposal
list. **Export included** writes an immutable JSONL snapshot and a digest- and
case-version-bound current manifest.
Exclusion reasons cover missing context, missing attachments, broken references,
ambiguous ground truth, sensitive content, duplicates, malformed captures,
out-of-scope cases, and `other`. Multiple reasons may apply; `other` requires an
explanation. Reviewer notes remain human-only audit context and are never written
to evaluation snapshots.
Review-derived cases also retain validated Discord guild, channel, and message
references outside the evaluation window. The local desk links pseudonymous
message labels back to Discord for authorized reviewers; these identifiers and
URLs are never written to evaluation snapshots.

When `DISCORD_TOKEN` and `ORGANIZER_GUILD_ID` are available locally, **Recover
context** accepts up to 40 exact Discord message links from the organizer guild.
The desk retrieves those messages through Discord REST without starting another
Gateway client, reuses existing author aliases, assigns new pseudonymous message
IDs, and previews the result before changing the draft. Applying a recovery
resets the case to `pending`; the reviewer must verify evidence roles and proposal
sources, then save and include it normally. Recovered source IDs and links remain
review-only, and ETag checks prevent recovery from being applied over a newer
case version. Daily synchronization preserves recovered evidence while its base
source fingerprint is unchanged.

Recovery currently preserves attachment metadata only. It does not retain image
bytes, and the dialog warns when a recovered message has attachments. Keep a case
excluded with `missing_attachment` whenever attachment contents are necessary to
establish the expected outcome.

Start `tth-bot-ai-evaluate` manually before release decisions; reports are
written under `reports/<run-id>/` and corpus text is not printed to logs.

## Cost controls

Per-case predictions are cached by corpus content, pipeline version, deployment,
API version, context limit, image limit, and completion-token limit. Cached
results contribute to quality metrics without new provider tokens or latency.
During iteration, prefer `--case` or `--changed`; use `--full` for an explicit
release run and `--fresh` only to bypass compatible cache entries.

`AI_EVAL_MAX_UNCACHED_CASES` defaults to 25 and blocks larger accidental runs.
The corpus sync job runs daily at 0.25 vCPU/0.5 GiB, while evaluation is manual
and scales to zero. The embedding safety job runs daily because the always-on
bot already performs incremental synchronization every ten minutes.

## Legacy file export

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

Included proposals use their final reviewed title, action, source messages, and
target semantics. The direct Dismiss control records `not_actionable` and becomes
a negative case. The direct Incorrect control records `incorrect_proposal` and is
excluded until a corrected expected result is reviewed. Historical clear-negative
dismissal reasons remain exportable, while sensitive overrides, sensitive/private
dismissals, duplicates, ambiguous reasons, and pending reviews are excluded.
Reviewer retargeting, source-lineage action
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
