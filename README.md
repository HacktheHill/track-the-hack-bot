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
- **Message → Apps → Create OpenProject task**: Create from a message with a backlink.
- **Message → Apps → Draft OpenProject task with AI**: Create a private, reviewable
  proposal in an AI-allowlisted channel; it never auto-creates a task.

The bot also synchronizes the configured Organizer role and nickname when a
member joins the Community server.

### OpenProject task integration

The integration is enabled when `OPENPROJECT_BASE_URL`, `OPENPROJECT_API_KEY`,
`DATABASE_URL`, `ORGANIZER_GUILD_ID`, `ORGANIZER_GUILD_MEMBER_ROLE_ID`, and
`ORGANIZER_GUILD_ORGANIZER_ROLE_ID` are valid. If they are not, verification,
synchronization, and help remain available while task interactions are disabled.

On startup, the bot creates or updates its PostgreSQL schema and seeds identity
and category mappings from the environment. Organizers can then maintain those
mappings with `/task link-user` and `/task configure-category`. Members can
access projects associated with their channel category or configured team
roles. `OPENPROJECT_BLOCKED_CHANNEL_IDS` disables task creation in selected
channels.

Projects, priorities, types, users, and sizes are loaded from OpenProject. New
tasks default to today and seven days ahead. Similar open tasks are rejected;
manual `/task create` requests can use `allow_duplicate` to override that check.

Manual AI drafting requires an allowlisted channel in
`OPENPROJECT_AI_CHANNEL_IDS` and configured Azure OpenAI endpoint/deployment.
Automatic extraction is controlled separately by `OPENPROJECT_AUTOMATION_MODE`:

- `off` disables automatic extraction.
- `shadow` stores proposals without posting review cards.
- `review` posts human-review cards after the configured channel idle period.

Azure OpenAI authentication uses managed identity rather than an API key. The
bot bounds the context, aliases Discord identities, redacts common credentials
and contact details, and rejects matching sensitive discussions before making
an Azure request. This reduces exposure but is not a guarantee; use manual task
creation for sensitive discussions. Keep automatic extraction off until it has
been evaluated on representative conversations.

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
[infra/README.md](infra/README.md).

## Contributing

Contributions are welcome! For major changes, please open an issue first to discuss what you would like to change.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.

## Contact

For more information, please contact us at [development@hackthehill.com](mailto:development@hackthehill.com).
