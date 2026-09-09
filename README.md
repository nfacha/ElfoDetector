# twitch-watcher

A Node.js/TypeScript bot that watches Twitch channels and alerts when a streamer edits their channel metadata (title/category/language) **while offline** — a strong signal they're about to start a stream.

## How it works

The bot connects to Twitch's [EventSub](https://dev.twitch.tv/docs/eventsub) API over a WebSocket and subscribes to three events per channel:

| Event | Used for |
|---|---|
| `channel.update` (v2) | **Detection** — fires when the streamer changes title/category/language/content labels |
| `stream.online` | **State tracking only** — marks the channel as live, no notification |
| `stream.offline` | **State tracking only** — marks the channel as offline, no notification |

When a `channel.update` event arrives and the channel is **offline**, the bot fires an alert (console log + optional Twitch chat message). If the channel is live, the update is cached silently — the streamer is already "there", not *about* to be.

Title/category changes persist after a stream ends, so the bot caches last-known metadata and live status in SQLite. This prevents false alerts across restarts (e.g. it won't re-alert on a title that changed yesterday). On boot, live status is re-synced via the Helix API.

> **Note:** Editing metadata before going live is not guaranteed for every streamer — this bot catches the common "prep" pattern but can't be 100% reliable.

## Prerequisites

- Node.js 18+ (for local dev)
- A [Twitch developer application](https://dev.twitch.tv/console/apps) (client ID + secret)
- A **user** access token for your own app
- [Docker](https://docs.docker.com/get-docker/) + Docker Compose (optional, for containerized run)

### Getting a token for YOUR app

Staff-less EventSub subscriptions like `channel.update` need no OAuth scopes, but the token must be issued by **your** client ID. The generic generator on `twitchtokengenerator.com` issues tokens under *their* client ID and will fail — validate:

- Use the OAuth Authorization Code flow for your app: https://dev.twitch.tv/docs/authentication/getting-tokens-oauth
- Or twitchtokengenerator.com with your custom client ID
- If you want chat messages: include the `chat:read` + `chat:edit` scopes

The bot validates the token against `id.twitch.tv/oauth2/validate` at startup and will refuse to start with a clear error if it's malformed, expired, or issued by the wrong app.

## Setup

```bash
npm install
cp .env.example .env        # fill in credentials
cp config.example.json config.json   # choose channels
```

### `.env`

```ini
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret   # optional (refresh flow)
TWITCH_ACCESS_TOKEN=your_user_access_token
TWITCH_BOT_USERNAME=your_bot              # only needed for chat messages
```

`CHANNELS_CONFIG` and `DB_FILE` are optional and default to `config.json` and `data/watcher.db`.

### `config.json`

```json
{
  "channels": [
    {
      "name": "shroud",
      "notifyByChat": false,
      "chatMessage": "Hey @{streamer}, getting ready to stream?"
    },
    {
      "name": "lirik",
      "notifyByChat": true,
      "chatMessage": "{streamer} is setting up!"
    }
  ]
}
```

| Field | Default | Purpose |
|---|---|---|
| `name` | — | Channel username to watch (required) |
| `notifyByChat` | `false` | Send the alert as a chat message to that channel |
| `chatMessage` | `Hey @{streamer}, getting ready to stream?` | Message template; `{streamer}`, `{title}`, `{category}` are replaced |

Any channel with `notifyByChat: true` enables the chat client at startup; if none, chat is skipped entirely.

## Run locally

```bash
npm run dev       # tsx watch (auto-reload on code changes)
```

or production-style:

```bash
npm run build
npm start
```

## Run with Docker

```bash
docker compose up -d     # build & start in the background
docker compose logs -f   # follow logs (ALERT lines appear here)
docker compose down      # stop (SQLite state survives in the volume)
```

The Compose setup:

- injects `.env` into the container
- bind-mounts `config.json` so you can edit channels without rebuilding
- persists `data/watcher.db` in a named volume (`twitch-watcher-data`)

### Plain Docker

```bash
docker build -t twitch-watcher .
docker run --rm \
  --env-file .env \
  -v "$(pwd)/config.json:/app/config.json:ro" \
  -v twitch-watcher-data:/app/data \
  twitch-watcher
```

## Output

On an offline metadata change:

```
[INFO] ALERT: DuckCitizen is preparing to go live (offline metadata change)
[INFO]   title:    League grind -> VALORANT with viewers
[INFO]   category: Valorant           -> League of Legends
```

If `LOG_LEVEL=debug` is set, live/offline transitions are logged as `[internal]` lines without triggering alerts.

## Project layout

```
src/
├── index.ts      # entry point: load config → sync state → start EventSub + chat
├── config.ts     # env + config.json loading, token validation, channel resolution
├── state.ts      # SQLite store (cached title/category/live status)
├── detector.ts   # EventSub handlers + offline-metadata-change detection
├── chat.ts       # optional IRC chat notifications
└── logger.ts     # leveled, timestamped logging
```