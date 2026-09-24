# Track the Hack Bot

Track the Hack Bot verifies hackers, synchronizes organizer roles, and provides
the Hack the Hill Discord-to-OpenProject task workflow.

## Prerequisites

- Node.js 24
- A Discord application installed in the Organizer and Community servers
- PostgreSQL for participant verification; OpenProject is optional for the task integration

## Local setup

1. **Clone the Repository**

    ```bash
    git clone https://github.com/hackthehill/track-the-hack-bot.git
    cd track-the-hack-bot
    ```

2. **Install dependencies**

    ```bash
    npm ci
    ```

3. **Configure the environment**

    ```sh
    cp .env.example .env
    ```

    Fill in the core Discord, role, log-channel, Track the Hack URL, and HMAC
    values in `.env`. `CLIENT_ID` is required when registering commands. The
    remaining OpenProject, mapping, and optional Azure OpenAI values
    are documented in [.env.example](.env.example).

    The core runtime values are:

    | Variable                            | Purpose                                                                        |
    | ----------------------------------- | ------------------------------------------------------------------------------ |
    | `DISCORD_TOKEN`                     | Discord bot token                                                              |
    | `COMMUNITY_GUILD_ID`                | Community server                                                               |
    | `ORGANIZER_GUILD_ID`                | Organizer server                                                               |
    | `COMMUNITY_GUILD_HACKER_ROLE_ID`    | Role assigned after verification                                               |
    | `COMMUNITY_GUILD_ORGANIZER_ROLE_ID` | Organizer role managed in the Community server                                 |
    | `ORGANIZER_GUILD_ORGANIZER_ROLE_ID` | Source Organizer role and mapping-admin role                                   |
    | `LOG_CHANNEL_ID`                    | Community verification log channel                                             |
    | `TRACK_THE_HACK_URL`                | Public Track the Hack application URL                                          |
    | `INTERNAL_API_SECRET`               | At least 32 random characters, shared with Track for signed links and requests |
    | `DATABASE_URL`                      | Bot-owned PostgreSQL database; never Track MySQL                               |

    `PORT` is optional and defaults to `4000`.

4. **Register Discord commands**

    ```bash
    npm run register
    ```

    Run this once for a new Discord application and again whenever the command
    definitions change.

5. **Build and start the bot**

    ```bash
    npm run build
    npm start
    ```

    For development with automatic restarts, use `npm run dev` instead.

### Discord application setup

Enable the **Server Members Intent** and **Message Content Intent** in the
Discord Developer Portal. Install the application with the `bot` and
`applications.commands` scopes in both servers. The bot needs access to the
channels it operates in, including permission to read message history and send
messages. It also needs Manage Roles and Manage Nicknames, with its bot role
above the Hacker and Organizer roles that it manages.

## Participant verification

The bot gives each participant a private five-minute `/discord#...` link with
an opaque random reference and HMAC signature. The participant must activate
their day-of access in Track using the same browser, then press Verify. Track
sends the signed proof and the session-derived Hacker ID to `/verify`; it never
receives a Discord ID. Old raw-ID links/payloads are rejected.

The bot's `discord_verification_challenges` table holds hashed references,
Discord IDs, and expiry. `discord_participant_links` persists a unique binding
in each direction. A failed Discord role assignment keeps the binding so the
same participant can retry, including with a new link. Existing Hacker roles
still require a binding. A conflict response identifies only whether the
Discord account, participant pass, or both already have a binding; it never
returns the other identifier. Conflicting bindings require organiser
intervention, with no silent reassignment or automatic role revocation.

Track uses that binding for participant notifications without receiving Discord
identifiers. Signed `POST /participant-links/status` requests return only Hacker
IDs and linked booleans. Signed `POST /notifications/deliver` requests accept up
to 50 stable delivery IDs and Hacker IDs, resolve the private Discord identity
inside the bot, and send direct messages with mentions disabled. The
`notification_delivery_receipts` table makes confirmed sends idempotent; an
ambiguous interrupted send becomes `uncertain` and is never retried
automatically.

The full bot-side notification contract, migration/readiness requirements, failure
semantics, and test rules are in
[`docs/notifications.md`](docs/notifications.md). The cross-service real-provider
acceptance checklist is maintained in Track's notification runbook and must be
completed with a designated test participant and a separate confirmation immediately
before any external message.

Both tables are created at startup by default, independently of OpenProject.
To manage migrations externally, run `npm run migrate:db`, then set
`VERIFICATION_RUN_MIGRATIONS=false`. Startup checks the tables exist. Expired
challenges are cleaned up at startup, every 15 minutes, and when new links are
generated. Bindings persist across restarts and belong to the current event's
participant dataset.

Run bot-owned maintenance from a trusted environment with the bot database
configuration. Commands report counts only and never print participant or
Discord identifiers:

```sh
npm run verification:manage -- cleanup
npm run verification:manage -- unlink --discord-id DISCORD_ID
npm run verification:manage -- unlink --hacker-id PARTICIPANT_ID
npm run verification:manage -- reset --confirm-current-event-reset
```

Unlink removes the binding and every outstanding challenge for the resolved
Discord account in one transaction. Reset locks and clears both verification
tables. Pause verification before a reset so an in-flight request cannot recreate
a binding. These database operations do not remove Discord roles. Role removal
is a separate organizer decision because the bot does not know whether a member
held the role before participant verification.

Configure the matching `INTERNAL_API_SECRET` and `DISCORD_BOT_URL` in Track,
and `TRACK_THE_HACK_URL` here. Use HTTPS for deployed URLs and deploy the
matching Track/bot changes together. Generate fresh links after rollout.
No Discord command-registration changes are required.

For credential-free testing, build this bot, then run `npm run test:e2e:discord`
in the adjacent Track checkout (or set its `DISCORD_BOT_REPO` path). The test
uses this repository's production proof generator, HTTP router, PostgreSQL
store, and role-assignment adapter; only the Discord API calls are doubled.
It provisions a disposable local database and never logs into Discord. Full
wire protocol and test details are in Track's `docs/DISCORD_VERIFICATION.md`.

## Usage

### Commands

- **`/verify`**: Get a Community-server verification link.
- **`/sync`**: Synchronize the configured Organizer role and nicknames to the
  Community server.
- **`/help`**: Show server-specific command help.
- **`/task create`**: Members-role users in the Organizer server create tasks;
  the title is required, while the project can be selected explicitly or
  inferred by matching the channel name and then its category name to an active
  OpenProject project, or from one unambiguous proposed-owner team. Description,
  assignee, accountable user, priority, size, dates, and estimates are optional.
- **`/task view|assign|reschedule|close|reopen|announce`**: Manage an existing task.
- **`/task link-user`, `/task reconcile`**: Organizer-only identity mapping and
  ambiguous-create recovery commands.
- **`/task metrics`**: Organizer-only AI proposal outcomes, edit rates, latency,
  token usage, and failure counts for the previous 7, 30, or 90 days.
- **`/task extract`**: Organizer-only forced extraction from recent channel
  messages. It does not require an explicit assignment, but still requires
  significant incomplete work and human review.
- **Message → Apps → Create OpenProject task**: Create from a message with a backlink.
- **Message → Apps → Draft OpenProject task with AI**: Create a private, reviewable
  proposal; it never auto-creates a task.

The bot also synchronizes the configured Organizer role and nickname when a
member joins the Community server.

### OpenProject task integration

The integration is enabled when `OPENPROJECT_BASE_URL`, `OPENPROJECT_API_KEY`,
`DATABASE_URL`, `ORGANIZER_GUILD_ID`, `ORGANIZER_GUILD_MEMBER_ROLE_ID`, and
`ORGANIZER_GUILD_ORGANIZER_ROLE_ID` are valid. If they are not, verification,
synchronization, and help remain available while task interactions are disabled.

`npm run migrate:db` creates or updates the PostgreSQL schema and seeds identity
mappings from the environment. Runtime migrations are disabled by
default and can be enabled explicitly for local development with
`OPENPROJECT_RUN_MIGRATIONS=true`. Organizers can then maintain user mappings
with `/task link-user`. Internal Organizer channels can select any active project
visible to the OpenProject integration account. Project defaults match the
normalized channel name first and category name second. When neither matches,
one unambiguous team project from the proposed assignee, or an explicitly chosen
accountable person when there is no assignee, provides the default. AI proposals
may then infer an exact active project name from their cited discussion; the
source-message author's team is never used for routing.
`OPENPROJECT_BLOCKED_CHANNEL_IDS` remains supported
for exact channel blocks. `OPENPROJECT_EXCLUDED_CHANNEL_IDS` accepts both
channel and category IDs; category IDs exclude all descendant channels and are
used for the External and Information categories. Exclusions block manual and
automatic task creation and extraction.

The bot also reconciles unmapped Organizer members with assignable active or
invited OpenProject users at startup and daily. It auto-links only unique exact
names, unique first-name/last-initial matches, unique first names, or duplicate
first names disambiguated by configured Discord team role and OpenProject group.
Existing mappings are never overwritten; ambiguous matches require
`/task link-user`.

For new-task AI proposals, the selected message's author is Accountable and an
explicit Discord mention or uniquely resolved Organizer nickname is the
Assignee. All new task paths preserve explicit planning metadata and otherwise
infer priority from urgency or a stated deadline, infer size from scope or a
provided estimate, and derive estimates from size. Sparse work defaults to
OpenProject's Normal/default priority, Small, and 2 hours; Medium, Large, and
X-Large default to 6, 16, and 32 hours. When no deadline is stated for a new
task, the bot derives one from the validated priority and size:
Normal starts at 14 days, with shorter windows for High/Immediate work and
additional time for Medium, Large, and X-Large work.

Final task review drafts remain actionable for 24 hours by default. Configure
this with `OPENPROJECT_DRAFT_TTL_MINUTES`; creating a task still atomically
claims the draft so repeated clicks cannot create duplicates.

Date defaults, Today/Tomorrow labels, and scheduled clock times use
`BOT_TIME_ZONE`, which defaults to `America/Toronto` for Eastern Time with
automatic EST/EDT daylight-saving changes.
Start-date autocomplete includes the previous and next 30 days; due-date
autocomplete remains forward-looking.

Projects, priorities, types, users, and sizes are loaded from OpenProject. New
tasks default to today and seven days ahead. Similar open tasks are rejected;
manual `/task create` requests can use `allow_duplicate` to override that check.

Manual AI drafting requires a configured Azure OpenAI endpoint/deployment.
Automatic extraction is controlled separately by `OPENPROJECT_AUTOMATION_MODE`:

- `off` creates no new automatic proposals and performs no uncited extraction.
- `shadow` records extraction and gate decisions without creating new proposals
  or posting review cards.
- `review` posts human-review cards after the configured channel idle period.

In all three modes, edits and deletions can maintain already-pending proposals
that cite the changed message. This source maintenance never creates an
unrelated proposal; it keeps cited pending review evidence accurate even while
new automatic proposal creation is disabled.

AI extraction runs in every channel except those listed in the blocked or
excluded ID lists. Excluded category IDs apply to all descendant channels.
Automatic extraction evaluates each focal message with topic-bounded preceding
and subsequent context, plus available reply targets and thread roots. It posts
only candidates classified as durable work: assignments, commitments, concrete
requests, required deliverables, remaining work, actionable problem statements,
tracked completions, or reopen requests. Informational results, status-only
reports, already resolved work, transient synchronous help, hypotheticals,
placeholder text, and meta-discussion about the bot are retained as decision
telemetry but do not become proposals.

Manual extraction is intentionally broader because invoking the command supplies
human intent. It can return any meaningful work grounded in the selected focal
context even when the same candidate would not pass the automatic eligibility
gate. The automatic eligibility assessment is still recorded so manual cases can
be used to measure automatic false negatives.

Review outcomes store timestamps, status counters, token/latency values,
per-field edits, bounded minimized inputs, proposal decisions, structured
automatic-gate assessments, and revisions for 90 days. Pending proposals are
revised when their cited messages or attachments change. Raw Discord transcripts
are never copied into task descriptions.
Production uses `review` mode: AI may post a proposal, but only a permitted
human reviewer can create or dismiss the task. Immediately before a proposal is
claimed for application, every cited Discord message is refetched and its raw
content and attachment IDs/URLs are compared with the proposal's source hash.
Confirmed deletion or changed evidence supersedes only a still-pending proposal;
transient Discord fetch failures block application but remain retryable;
deletion listeners never rewrite an already-creating row because its remote
OpenProject mutation may have started.

`/task link-user` can link Discord members to active or invited OpenProject
accounts. Linked accounts can be used as Assignee or Accountable without being
project members; OpenProject's work-package form remains the final validation
authority for both relationships. Task creators do not need an OpenProject
account or project membership; Discord project access controls creation.

RAG is independently controlled by `OPENPROJECT_RAG_MODE`. The recommended
rollout is `off`, then `shadow`, then `review`. `shadow` synchronizes
OpenProject title and description embeddings into PostgreSQL with pgvector but
does not propose updates. The `sync:embeddings` job is suitable for a
Container Apps scheduled job.

The five strongest hybrid retrieval results are assessed together by the
configured Azure OpenAI chat deployment as the same work, related work, or
unrelated work. Only a high-confidence same-work result with a clear margin is
nominated automatically. Up to three same or related results are shown in a
reviewer-authorized target selection control; submitted targets are checked against
the proposal's stored candidate set and refetched before use. Retrieval or
reranking failures degrade to no suggestion rather than blocking task review.
Both `AZURE_OPENAI_DEPLOYMENT` and the embedding settings are required when RAG
is enabled because the reranker receives the proposed title and description and
the retrieved OpenProject titles and descriptions.

RAG matches are advisory: they never turn a proposed new task into an update or
suppress its review card without a reviewer decision. A reviewer can keep the
new task or select an existing task, which safely replans the proposal as an
update. For an action that explicitly updates, completes, or reopens existing
work, an exact task reference or a confidently reranked RAG result nominates the
target. Existing-task metadata is changed only when the discussion
explicitly requests that field. New requirements and clarifications are posted
as Markdown activity comments, while a description is replaced only when the
existing description has no substantive content or the discussion explicitly
requests a rewrite. Every mutation checks the OpenProject `lockVersion`, and
correlated comments are deduplicated across retries.

AI-generated descriptions keep cohesive prose compact and use Markdown bullets
for independently actionable requirements or genuine lists. Sparse discussions
remain concise rather than receiving invented headings, objectives, acceptance
criteria, or notes.

Azure OpenAI authentication uses managed identity rather than an API key. The
bot bounds the context and total image count, aliases Discord identities,
redacts high-confidence credential values and contact details, and rejects
unredacted secret values before making an Azure request. A second structured AI
stage classifies contextual sensitivity after local redaction; sensitive or
uncertain candidates do not become automatic proposals. Image contents cannot
be screened before they are sent to Azure. For a manually requested draft, the
requester can explicitly proceed after a local block or contextual classification
for that one minimized request; the approval expires after ten minutes and is
never available to automatic extraction. This reduces exposure but is not a
guarantee. Evaluate extraction on representative conversations before enabling
it in production.

The canonical reviewed corpus lives in a private Azure Blob container. Real
review outcomes are synchronized by the private `tth-bot-corpus-sync` Container
Apps Job and enter an explicit inclusion queue. Start the review desk locally
after `az login`:

```bash
AI_CORPUS_STORAGE_ACCOUNT_URL=https://tthbotcorpus51fa.blob.core.windows.net \
  npm run corpus:ui
```

The server binds only to `127.0.0.1`, authenticates through
`DefaultAzureCredential`, and prints the local URL. Cases remain excluded from
evaluation until included. An included case with zero expected proposals is a
valid negative example. Unusable cases are retained as excluded records with
structured reasons, but never enter evaluation exports.

If `DISCORD_TOKEN` and `ORGANIZER_GUILD_ID` are set, the local desk can recover
missing text context from exact organizer-server message links. Recovery uses
Discord REST only, previews pseudonymized evidence, and resets the draft to
pending. It does not preserve attachment contents, so image-dependent cases must
remain excluded until private attachment storage is supported.

Use **Export included** in the UI, then start the manual
`tth-bot-ai-evaluate` Azure job. Local file evaluation remains available:

```bash
npm run evaluate:ai -- .private/reviewed-corpus.jsonl --changed
npm run evaluate:ai -- .private/reviewed-corpus.jsonl --case review-42
npm run evaluate:ai -- .private/reviewed-corpus.jsonl --full
```

Without `--full`, more than `AI_EVAL_MAX_UNCACHED_CASES` cache misses fail before
any provider request. Use `--fresh` only for a deliberately uncached run.
Full release runs enforce only the configured minimum corpus size, proposal
precision, and valid structured-output rate. JSON reports contain `passed` and
`thresholdFailures`; recall, owner, and deadline metrics are reported but do not
fail the run.

The legacy file exporter builds an initial corpus from normal proposal reviews. Accepted
manual extractions are evaluated in automatic mode as examples the automatic
workflow should detect. Accepted automatic proposals, reviewer corrections, and
clear negative dismissals are also used. Proposal cards expose direct Review,
Dismiss, and Incorrect controls: Dismiss is a no-task label, while Incorrect is
excluded until a corrected outcome is reviewed. Sensitive, duplicate-only, and
otherwise under-specified outcomes are excluded rather than guessed. New extraction events
are linked directly to their proposals, so only reviews collected after the
corresponding database migration can be exported reliably. Run the exporter only
in the private runtime with database access and keep its mode-0600 output outside
source control.

Each line contains `id`, `mode`, `messages`, and `expected.proposals`. Every
expected proposal includes `action`, `titleIncludes`, and `sourceMessageIds`,
and may include `assigneeAlias` and `dueDate`. Existing-task cases can list
candidate-specific `routing.availableTargetSourceMessageIds` to model the
validated project/RAG state. Use an empty
proposal list for a no-action window. The command writes mode-0600 JSON and
Markdown reports next to the corpus. Use 100 representative windows. Release
runs require 95% proposal precision and 99% valid structured output by default;
owner/deadline accuracy and recall are diagnostics rather than release gates.
Aggregate baselines and their limitations are recorded in
[docs/ai-evaluation.md](docs/ai-evaluation.md).

### Local containers

The Compose configuration runs the bot with PostgreSQL for local development
and smoke testing. After configuring `.env`, start it with:

```bash
POSTGRES_PASSWORD=change-me docker compose -f docker-compose.local.yml up --build
```

### Container deployment

Production runs as a private Azure Container App with managed PostgreSQL. The
bot exposes `/healthz` and `/readyz`; Track the Hack calls `/verify`,
`/participant-links/status`, and `/notifications/deliver` over private
HTTPS with `x-track-the-hack-timestamp` and `x-track-the-hack-signature`
(HMAC-SHA256 over the endpoint-specific domain, timestamp, and exact JSON body).
Verification, link-status, and notification-delivery signatures use separate domains.
Invalid or expired signatures are rejected.
Bot-specific deployment and release guidance is in
[docs/deployment.md](docs/deployment.md).

### Backups

Production backup infrastructure and restore procedures are owned by the
private [`infrastructure`](https://github.com/HacktheHill/infrastructure)
repository. Cloudflare R2 is not included in the Azure backup system.

## Contributing

Contributions are welcome! For major changes, please open an issue first to discuss what you would like to change.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.

## Contact

For more information, please contact us at [development@hackthehill.com](mailto:development@hackthehill.com).
