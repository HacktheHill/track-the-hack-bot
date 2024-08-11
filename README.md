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

### Synchronization

When a new member joins the Community server, the bot automatically synchronizes their roles and nickname with those from the Organizer server. This can also be triggered manually using the `/sync` command.

## Contributing

Contributions are welcome! For major changes, please open an issue first to discuss what you would like to change.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.

## Contact

For more information, please contact us at [development@hackthehill.com](mailto:development@hackthehill.com).
