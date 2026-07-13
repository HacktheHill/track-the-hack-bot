# Track the Hack Bot

Track the Hack Bot is a Discord bot designed to automatically assign roles to verified hackers on the Hack the Hill server. It integrates seamlessly with the Track the Hack event management platform to streamline and secure the verification process for participants.

## Installation

1. **Clone the Repository**

   ```bash
   git clone https://github.com/hackthehill/track-the-hack-bot.git
   cd track-the-hack-bot
   ```

2. **Install Dependencies**

   ```bash
   npm install
   ```

3. **Set Up Environment Variables**

   Create a `.env` file in the root directory and add the following environment variables:

   ```bash
   DISCORD_TOKEN=
   ORGANIZER_GUILD_ID=
   COMMUNITY_GUILD_ID=
   COMMUNITY_GUILD_HACKER_ROLE_ID=
   COMMUNITY_GUILD_ORGANIZER_ROLE_ID=
   ORGANIZER_GUILD_ORGANIZER_ROLE_ID=
   LOG_CHANNEL_ID=
   SECRET_KEY=
   TRACK_THE_HACK_URL=
   ```

   Copy `.env.example` for the OpenProject, PostgreSQL, role/project mapping,
   prohibited-channel, and optional Azure OpenAI settings. Azure inference uses
   the bot workload's managed identity and does not accept a static API key.

   - `DISCORD_TOKEN`: Your Discord bot token.
   - `ORGANIZER_GUILD_ID`: The ID of the Organizer server.
   - `COMMUNITY_GUILD_ID`: The ID of the Community server.
   - `COMMUNITY_GUILD_HACKER_ROLE_ID`: The ID of the role to be assigned to verified hackers.
   - `COMMUNITY_GUILD_ORGANIZER_ROLE_ID`: The ID of the role to be assigned to organizers in the Community server.
   - `ORGANIZER_GUILD_ORGANIZER_ROLE_ID`: The ID of the role that organizers have in the Organizer server.
   - `LOG_CHANNEL_ID`: The ID of the channel to log bot activity.
   - `SECRET_KEY`: A secret key for verifying requests from the Track the Hack platform.
   - `TRACK_THE_HACK_URL`: The URL of the Track the Hack platform.
   - `PORT`: The port number on which the bot's server should run (default: 4000).

4. **Start the Bot**

   ```bash
   npm start
   ```

## Usage

### Commands

- **`/verify`**: Provides a verification link to the user to verify their account in the Community server.
- **`/sync`**: Synchronizes roles and nicknames between the Organizer and Community servers.
- **`/help`**: Displays information about the bot's commands and functionalities.
- **`/task create`**: Creates an OpenProject task for any Organizer-server member
  with the Members role. Description is optional; date fields offer upcoming-date
  autocomplete and also accept `YYYY-MM-DD`.
- **`/task view|assign|reschedule|close|reopen`**: Performs the small set of
  high-frequency task operations that should not require opening OpenProject.
- **`/task link-user`** and **`/task configure-category`**: Organizer-only setup
  commands for persistent Discord user and category mappings.
- **Message → Apps → Create OpenProject task**: Creates a task with an automatic backlink.
- **Message → Apps → Draft OpenProject task with AI**: Produces an ephemeral,
  editable proposal in an explicitly allowlisted channel before creating anything.

### OpenProject task integration

Run `npm run register` after changing application commands. The integration is
enabled only when `OPENPROJECT_BASE_URL`, `OPENPROJECT_API_KEY`, and
`DATABASE_URL` are set. On startup the bot creates its small PostgreSQL schema
and seeds Discord-to-OpenProject identity mappings from `OPENPROJECT_USER_MAP`.
Organizers can maintain mappings without editing environment variables through
`/task link-user` and `/task configure-category`. Task commands are available
only in the Organizer server to members with the configured Members role.

New tasks default to today and seven days from today unless overridden with
`OPENPROJECT_DEFAULT_START_TODAY` and `OPENPROJECT_DEFAULT_DUE_DAYS`. Priorities,
types, projects, and size values are read from OpenProject instead of fixed IDs.
Potentially duplicate open tasks are rejected with a link; `/task create` can
explicitly override this with `allow_duplicate`.

Enable the Discord developer portal's **Message Content Intent** for bounded AI
context collection. Task creation can be prohibited independently from AI
processing with `OPENPROJECT_BLOCKED_CHANNEL_IDS`; AI processing is opt-in with
`OPENPROJECT_AI_CHANNEL_IDS`.

Always-on extraction defaults to `off`. Use `shadow` to collect proposal metrics
without posting cards, then `review` to post human-review cards after each
configured idle interval. Automatic task creation is intentionally unavailable
until the shadow/review accuracy measurements justify adding that policy.

The bot uses Azure OpenAI through its managed identity. Conversation context is
bounded and pseudonymized, and extraction is rejected before any Azure request
when the deterministic sensitive-content filter matches. Prefer a Canadian
regional deployment when available; Global Standard processing must be
explicitly approved because inference can occur outside Canada. Keep automation
off until the representative evaluation corpus meets the acceptance criteria.

### Container deployment

The bot has a production Dockerfile and a local PostgreSQL Compose file. The
production target is Azure Container Apps with PostgreSQL Flexible Server; the
Compose file is for local development and smoke testing only. The bot exposes
`/healthz` for liveness and `/readyz` for readiness. The Track the Hack app
should call `/verify` over private HTTPS using `x-track-the-hack-timestamp` and
`x-track-the-hack-signature` (HMAC-SHA256 over `timestamp.body`). The legacy
`secretKey` body is retained temporarily for cutover compatibility.

### Synchronization

When a new member joins the Community server, the bot automatically synchronizes their roles and nickname with those from the Organizer server. This can also be triggered manually using the `/sync` command.

## Contributing

Contributions are welcome! For major changes, please open an issue first to discuss what you would like to change.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.

## Contact

For more information, please contact us at [development@hackthehill.com](mailto:development@hackthehill.com).
