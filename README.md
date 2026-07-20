# Track the Hack Bot

Track the Hack Bot verifies hackers, synchronizes organizer roles, and provides
the Hack the Hill Discord-to-OpenProject task workflow.

## Prerequisites

- Node.js 24
- A Discord application installed in the Organizer and Community servers
- PostgreSQL and OpenProject, if the task integration will be enabled

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
   remaining OpenProject, PostgreSQL, mapping, and optional Azure OpenAI values
   are documented in [.env.example](.env.example).

   The core runtime values are:

   | Variable | Purpose |
   | --- | --- |
   | `DISCORD_TOKEN` | Discord bot token |
   | `COMMUNITY_GUILD_ID` | Community server |
   | `ORGANIZER_GUILD_ID` | Organizer server |
   | `COMMUNITY_GUILD_HACKER_ROLE_ID` | Role assigned after verification |
   | `COMMUNITY_GUILD_ORGANIZER_ROLE_ID` | Organizer role managed in the Community server |
   | `ORGANIZER_GUILD_ORGANIZER_ROLE_ID` | Source Organizer role and mapping-admin role |
   | `LOG_CHANNEL_ID` | Community verification log channel |
   | `TRACK_THE_HACK_URL` | Public Track the Hack application URL |
   | `INTERNAL_API_SECRET` | Shared secret for signed verification requests |

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

## Usage

### Commands

- **`/verify`**: Get a Community-server verification link.
- **`/sync`**: Synchronize the configured Organizer role and nicknames to the
  Community server.
- **`/help`**: Show server-specific command help.
- **`/task create`**: Members-role users in the Organizer server create tasks;
  the title is required, while the project can be selected explicitly or
  inferred from the channel category or assignee's team. Description, assignee,
  accountable user, priority, size, dates, and estimates are optional.
- **`/task view|assign|reschedule|close|reopen|announce`**: Manage an existing task.
- **`/task link-user`, `/task configure-category`, `/task reconcile`**: Organizer-only
  identity, category mapping, and ambiguous-create recovery commands.
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
and category mappings from the environment. Runtime migrations are disabled by
default and can be enabled explicitly for local development with
`OPENPROJECT_RUN_MIGRATIONS=true`. Organizers can then maintain those
mappings with `/task link-user` and `/task configure-category`. Internal
Organizer channels can select any active project visible to the OpenProject
integration account; category and team mappings provide defaults rather than
authorization boundaries. `OPENPROJECT_BLOCKED_CHANNEL_IDS` remains supported
for exact channel blocks. `OPENPROJECT_EXCLUDED_CHANNEL_IDS` accepts both
channel and category IDs; category IDs exclude all descendant channels and are
used for the External category.

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

- `off` disables automatic extraction.
- `shadow` records extraction and gate decisions without storing proposals or
  posting review cards.
- `review` posts human-review cards after the configured channel idle period.

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
human reviewer can create or dismiss the task.

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

RAG matches are advisory: they are shown as possible duplicates and never turn
a proposed new task into an update or suppress its review card without a
reviewer decision. A reviewer can keep the new task or use the suggested
existing task, which safely replans the proposal as an update. For an action
that explicitly updates, completes, or reopens existing work, an exact task
reference or a close RAG result nominates the target and the reviewer confirms
its task ID. Existing-task metadata is changed only when the discussion
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

Run an offline evaluation against a private pseudonymized JSONL corpus outside
the repository:

```bash
npm run export:ai-corpus -- .private/reviewed-corpus.jsonl
npm run evaluate:ai -- .private/reviewed-corpus.jsonl
```

The exporter builds an initial corpus from normal proposal reviews. Accepted
manual extractions are evaluated in automatic mode as examples the automatic
workflow should detect. Accepted automatic proposals, reviewer corrections, and
clear negative dismissal reasons are also used. Dismissal asks the reviewer to
choose a reason; sensitive, ambiguous, duplicate-only, and otherwise
under-specified outcomes are excluded rather than guessed. New extraction events
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
Markdown reports next to the corpus. Use 100
representative windows and track 95% proposal precision,
90% owner/deadline accuracy, and 99% valid structured output as improvement
targets rather than automatic activation gates.
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
bot exposes `/healthz` and `/readyz`; Track the Hack calls `/verify` over private
HTTPS with `x-track-the-hack-timestamp` and `x-track-the-hack-signature`
(HMAC-SHA256 over `timestamp.body`). Invalid or expired signatures are rejected.
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
