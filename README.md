# Become an Influencer — Live Beta

A mobile-first multiplayer satire party game built with Node.js, Express, and Socket.IO. Players join by room code or QR, select an influencer persona, publish text/photo/video posts, react and comment, face challenges and events, and vote for the winner. A separate projector view shows the live feed and leaderboard.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000. Create a game from the host screen, then join on other devices.

## Deploy on Render

Create a Node Web Service from this repository with build command `npm install` and start command `npm start`. Set the health-check path to `/health`.

Set these server-only environment variables:

- `SUPABASE_URL`: the base project URL, for example `https://your-project.supabase.co`.
- `SUPABASE_SERVICE_ROLE_KEY`: a private Supabase service-role or secret API key. Never put this in frontend code.

Create a private Supabase Storage bucket named `game-media` and a table:

```sql
create table if not exists public.influencer_games (
  code text primary key,
  state jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);
create index if not exists influencer_games_expires_at_idx on public.influencer_games (expires_at);
alter table public.influencer_games enable row level security;
```

With Supabase configured, game state and uploaded media persist across server restarts. Rooms expire after 24 hours; cleanup runs at startup and periodically, so deletion may not occur at the exact expiry instant. Without Supabase, rooms are temporary.

## Game timing

The first five minutes are always **Introduce Yourself**: players introduce their fictional influencer persona. The original 15/30/60-minute challenge selections follow, making total play time **20/35/65 minutes** before the final voting period. Challenges advance in five-minute rounds. Each new room starts with a pinned **THE ALGORITHM** welcome post, and Reset restores it.

## Health and troubleshooting

- `GET /health` returns `{ "ok": true }` immediately when the server responds; it does not depend on Supabase.
- `GET /health/supabase` checks database and storage connectivity and reports diagnostic status. It does not upload a test file.

## Notes

The app is an early private beta. Uploaded photos/videos are limited to 8 MB each, and a game has a total media cap. Player reconnect credentials are private and should not be shared. Use only with trusted adult participants; there is not yet a full moderation or abuse-prevention system. Keep your host tab open to retain the host key.
