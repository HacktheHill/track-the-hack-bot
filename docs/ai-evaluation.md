# AI extraction evaluation

The private evaluation corpus and case-level reports are excluded from source
control. Commit only aggregate results; never commit Discord message text,
participant identifiers, or per-case model output.

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

The successful run used an eight-second minimum interval between provider
requests. Set `AI_EVAL_MIN_INTERVAL_MS` and `AI_EVAL_PROVIDER_RETRIES` for
future batch runs when the Azure deployment has limited request or token
capacity.
