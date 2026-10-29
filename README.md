# Discord server assistant

A self-hosted Discord bot for server configuration inspection, permission explanations, reviewed batch changes, and bounded AI assistance. See [the implementation plan](docs/project-plan.md) for scope, milestones, safety requirements, and release gates.

## Development setup

Requirements: Node.js 24 LTS and an application created in the Discord Developer Portal. For local development, enable the **Server Members Intent** only when a feature needs it; the initial `/health` command uses the Guilds intent only.

To try a pull request against a safe Discord test server, follow [the testing guide](docs/testing.md). Pull requests include a runnable tryout section, and GitHub Actions checks formatting, types, and the production build without Discord credentials.

1. Copy `.env.example` to `.env` and set the bot token, application ID, and development server ID. Keep `.env` private.
2. Install dependencies with `npm ci`.
3. Register the development command with `npm run deploy:commands`.
4. Start the bot with `npm run dev` and use `/health` in the development server.

Build the production JavaScript with `npm run build`; run it with `npm start`.

## Docker Compose

After creating `.env`, build and start the bot with `docker compose up --build -d`. To register or update the development slash command, run `npm run deploy:commands` in a Node.js environment with the same `.env` values. View service output with `docker compose logs -f bot` and stop it with `docker compose down`.

The initial service has no database and stores no Discord message content. Do not add real tokens, AI keys, server exports, or database files to Git.

