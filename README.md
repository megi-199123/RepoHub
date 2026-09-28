# 🎁 RepoHub — Mystery Box

A Jackbox-style party-game platform, growing out of an interactive mystery-box prize game. Invited hosts (tenants) sign in and run their own **rooms** — quick shuffle-and-pick games reachable by a link, or live host-run games played from everyone's phone.

## Quick start

```bash
npm install
npm run dev
```

- Landing page (join by code): <http://localhost:3000>
- Host sign-in: <http://localhost:3000/admin> (email `admin`, password `admin` until you set `ADMIN_PASSWORD`)

Requires Node.js 18+. Without `DATABASE_URL`, local development uses [PGlite](https://pglite.dev), an embedded Postgres stored in `./data`, so you don't need a database server to try it out.

| Variable         | Default   | Purpose                                                                 |
| ---------------- | --------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`   | —         | Postgres connection string. **Required in production.**                 |
| `ADMIN_PASSWORD` | `admin`   | Bootstraps the built-in `superadmin` account's password on first boot.  |
| `ADMIN_EMAIL`    | `admin`   | Bootstraps the built-in `superadmin` account's login (email field).     |
| `PORT`           | `3000`    | HTTP port                                                                |
| `DATA_DIR`       | `./data`  | Where the embedded local database lives when `DATABASE_URL` is unset    |
| `PG_POOL_MAX`    | `10`      | Max Postgres connections per instance                                   |

Run the tests with `npm test`. They use an in-memory embedded Postgres; set `TEST_DATABASE_URL` to run them against a real, throwaway database instead. The tests drop and recreate the tables.

## Users, tenants and rooms

RepoHub is invite-only. A **superadmin** (bootstrapped from `ADMIN_PASSWORD`/`ADMIN_EMAIL` on first boot) signs in at `/admin` and uses the **Users** tab to invite other hosts. Every user is a tenant: they see and manage only their own rooms, prizes, draws and uploads — another tenant's room, prize or draw is always a 404, never a 403 (so its existence is never leaked). The superadmin is a tenant too, plus the only one who can manage Users.

Everything happens inside a **room**, created from the backoffice's **Rooms** tab. A room has a **type**, chosen at creation:

- **Managed** — a live, host-run game. The host opens a host console (`/admin/room?code=123456`), players join from their phones with the room's 6-digit code and their name, and the host runs one round: start, optional countdown, reveal. The room is swept (auto-closed) if left idle, or closed by the host.
- **Default** — an always-on shuffle-and-pick game reachable by a link (`/play?code=123456`) or by entering the code on the landing page. No player name is needed. It's persistent — never swept — until its owner closes it.

Prizes, settings (title, subtitle, box count, style, assignment, show-prizes, plays-per-visitor, countdown) and every draw belong to one specific room. A new room starts with the 4 sample prizes, or can copy another room's prize list at creation time (`copyPrizesFrom`).

**Backoffice (`/admin`)**: sign in with email + password. Tabs are **Rooms** (create/edit/close, per-room prize editor with odds, per-room player/spectator/prize/draw counts), **Winners** (every draw across your rooms, including closed ones — filter by room, search, redeem toggle, CSV export), and **Users** (superadmin only — invite, disable/enable, reset a password; a superadmin can't disable or demote themself).

## How a default room plays

1. **Shuffle & Play** — the server deals a new round for that room, filling each box with one of its prizes.
2. **Pick a box** — it rattles, the lid flies off, and the prize pops out.
3. **Reveal** — a prize card shows the claim code (for winning prizes); closing it opens the remaining boxes.

The draw happens on the server, so players can't peek at box contents or pick a prize from the browser. A prize leaves the draw once its stock hits 0; when a room runs out, players see a friendly "all prizes claimed" message. Plays-per-visitor (0 = unlimited) is tracked per browser per room, so it's a soft, per-room limit.

Each prize can have an uploaded image with or without a border: turn the border off for a transparent PNG or a logo, so it displays edge-to-edge instead of sitting in a filled, framed tile. This shows everywhere the prize's image appears — the prize editor and its live preview, the lineup, box reveals, and the host console.

## Multiplayer (managed) rooms

Jackbox-style: the host runs one shared board on a big screen; each player joins from their own phone with a room code and picks their own box.

**Hosting**: Rooms tab → **Create room** → type **Managed** (pick a box count, style and optional countdown). This opens a host console at `/admin/room?code=123456` with:

- **Box count stepper** — grows or shrinks the room, live, right up until boxes lock in (see below)
- **Lock joins** — stop new players from taking a seat mid-game (watchers can still join)
- **Start** — deals the boxes and moves everyone from the lobby into picking
- **Countdown** — arms a timer that locks all boxes when it hits zero
- **Reveal next** / **Reveal all** — opens boxes one at a time or all at once
- **Kick** — removes a player; their seat is simply freed, nobody is auto-promoted into it
- **Close** — ends the room immediately for everyone

Two separate links, same room code: a **player link** (`/?code=123456`, the landing page — enter the code and a name to take a seat) and a **watch link** (`/watch?code=123456` — no name needed, always available, even once joins are locked or the game is over). The host console and the admin room detail page both show Copy/Open for each.

**Live box count**: the host (or the admin room-detail page) can change the box count any time before boxes lock in — in the lobby, or even mid-game while players are still picking. Shrinking below the number of already-seated players is refused; shrinking while picking re-deals the boxes from this room's own prizes and releases the lock on any box index that no longer exists (that player just picks again). A running countdown is undisturbed. Once boxes lock in (countdown expires, or a reveal starts), the count is fixed.

**Joining vs. watching**: `/api/rooms/join` only ever seats a player — once every seat is taken, or once the game is revealing or finished, it responds with a "you can still watch" message instead of silently turning the caller into a spectator. Watching is its own explicit action (the watch link, or a "Just watch" / "Watch instead" button), always allowed, and never limited by seat count. A visitor who's already watching can later take a name and join for real, becoming a player, if a seat is still free. Room codes are numeric with leading zeros kept (e.g. `007123`), unique among active (non-closed) rooms, and every by-code endpoint (lookup, join, watch, a default room's config/rounds/pick) shares one rate limit: 10 failed attempts per IP per 5 minutes, then a 429. A managed room closes on its own if left idle: 2 hours in the lobby or mid-game, 30 minutes after it finishes. A default room is never swept.

**Seats and spectators**: a managed room has as many seats as boxes. Spectators watch the shared board and cursors but can't pick, and there's no limit on how many can watch. A managed room plays one round; to play again the host creates a new room.

**Reveal and stock**: only locked (claimed) boxes take prize stock and get a claim code when revealed; boxes nobody picked are opened for show with no draw recorded. Reconnecting (same browser, same room) restores your seat and any box you'd already locked.

Rooms reuse the same 5 box styles (gift, card, suitcase, chest, egg), chosen per room at creation.

**Chat**: every managed room has a live chat, on by default (toggle it per room in Settings, or at creation). Seated players and the host can send messages (200 characters max, a per-visitor rate limit of 5 messages per 10 seconds and at least 700ms apart); watchers read along and can send reactions but not messages. Everyone gets the last 50 messages the moment they join (the host always does, even while chat is off, to review or moderate). The host can turn chat on/off (which immediately updates everyone's view) and delete any message. Reactions are a fixed set of 8 emoji, throttled to about one every 1.5 seconds per visitor, shown as a brief animation rather than stored. A default room has no chat — it has no live board for one to attach to.

## Project layout

```
server/
  index.js    entry point (env config)
  app.js      Express app: auth, public/admin API, validation
  auth.js     password hashing (scrypt) and verification
  draw.js     box filling, weighted picks, odds estimation
  db.js       Postgres (pg) or embedded PGlite connection
  store.js    schema, migrations and all SQL queries (every prize/draw/round query is room- or owner-scoped)
  realtime.js Socket.IO wiring: room:join (session-checked for hosts), cursor relay, game:action, host:action
  rooms/      RoomService (room/player bookkeeping, per-code rate limiting), room codes, constants
  games/      game plugins (mysteryBox) — dealing, locking, revealing, per-viewer views
  httpError.js, validate.js, cookies.js, codes.js, prizeView.js, ratelimit.js   shared helpers
public/
  index.html, js/landing.js                        landing page: enter a code, or "Host sign in"
  play.html                                         a default room's shuffle-and-pick game
  join.html                                         static fallback that 302s to / (the server already does this)
  room.html, js/room.js, js/board.js, css/room.css  managed-room player/watch page (`/room` and `/watch` both serve it; room.js tells them apart by path)
  admin/                                            the backoffice: Rooms / Winners / Users tabs, host console (room.html/room.js)
api/index.js  Vercel serverless entry point (legacy; see note below)
vercel.json   Vercel routing (legacy; see note below)
test/
  api.test.js, rooms.test.js, migration.test.js, fixtures/legacySchema6f0e11f.js
```

> **Note on `api/index.js` / `vercel.json`:** rooms need WebSockets (Socket.IO) and a persistent process, which a Vercel serverless function can't provide, so these files are no longer a supported deploy target — see **Deploying** below.

## Deploying

Rooms need a long-running Node process (WebSockets for Socket.IO), so RepoHub is deployed to a host that runs `npm start` continuously.

### Railway (or any long-running Node host)

1. **Create the database.** Add a **PostgreSQL** plugin to your Railway project (or bring your own Postgres — Neon, Supabase, a VPS, …).
2. **Set environment variables**: `DATABASE_URL` (the private URL works fine when the app runs in the same Railway project as the database), `ADMIN_PASSWORD`, and optionally `ADMIN_EMAIL`.
3. **Deploy.** `npm start` runs `server/index.js`, which opens the HTTP server, attaches Socket.IO, and waits for the database migration before accepting traffic. Tables are created and the superadmin account bootstrapped automatically on first boot.

Tips:

- If the connection fails with a certificate error, append `?sslmode=no-verify` to `DATABASE_URL`.
- The migration is safe to run on every boot (it always has been) — new instances, redeploys and restarts all just re-run it, which is a no-op once everything is in place.
