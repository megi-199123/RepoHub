# 🎁 Mystery Box

An interactive mystery-box prize game with a backoffice for configuring prizes.

Players shuffle a set of gift boxes, pick one, and watch it burst open with confetti to reveal their prize — then see what was hiding in the other boxes. Winners get a claim code that staff can look up and mark as redeemed in the backoffice.

## Quick start

```bash
npm install
npm run dev
```

- Game: <http://localhost:3000>
- Backoffice: <http://localhost:3000/admin> (password `admin` until you set `ADMIN_PASSWORD`)

Requires Node.js 18+. Without `DATABASE_URL`, local development uses [PGlite](https://pglite.dev), an embedded Postgres stored in `./data`, so you don't need a database server to try it out.

| Variable         | Default   | Purpose                                                                 |
| ---------------- | --------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`   | —         | Postgres connection string. **Required in production.**                 |
| `ADMIN_PASSWORD` | `admin`*  | Backoffice password. *On Vercel there is no default: sign-in is disabled until it's set. |
| `PORT`           | `3000`    | HTTP port (local / long-running server only)                            |
| `DATA_DIR`       | `./data`  | Where the embedded local database lives when `DATABASE_URL` is unset    |
| `PG_POOL_MAX`    | 3 on Vercel, else 10 | Max Postgres connections per instance                      |

Run the tests with `npm test`. They use an in-memory embedded Postgres; set `TEST_DATABASE_URL` to run them against a real, throwaway database instead. The tests drop and recreate the tables.

## How it plays

1. **Shuffle & Play** — the server deals a new round, filling each box with a prize, while the boxes shuffle on screen.
2. **Pick a box** — it rattles, the lid flies off, and the prize pops out.
3. **Reveal** — a prize card shows the claim code (for winning prizes); closing it opens the remaining boxes.

The draw happens on the server, so players can't peek at box contents or pick a prize from the browser.

## Backoffice

**Prizes**: name, description, emoji or uploaded image, color, weight, stock (or unlimited), active, and *counts as a win* (turn this off for "Try again"-style prizes: no confetti and no claim code). Each prize card shows its estimated win chance and how many times it's been won.

**Settings**:

- Title and subtitle
- Number of boxes (2–12)
- How prizes go into boxes:
  - **Different prize in every box**: boxes hold distinct prizes while there are enough. With 4 prizes and 4 boxes, every prize is in every round (1-in-4 each). Weight only matters when there are more prizes than boxes.
  - **Pure odds**: each box is an independent weighted draw, so weight maps directly to win chance. Use this when a grand prize should be rare.
- Whether to show the "What's inside?" prize lineup
- Plays per visitor (0 = unlimited). This is tracked with a browser cookie, so it's a soft limit.

**Winners**: every box opened, with search and filters, redeem toggles, CSV export and a button to clear the log.

Everything, including uploaded prize images, is stored in Postgres, so no separate file storage is needed.

A prize leaves the draw once its stock hits 0. When no prize is available, players see a friendly "all prizes claimed" message.

## Multiplayer rooms

Jackbox-style: the host runs one shared board on a big screen; each player joins from their own phone with a room code and picks their own box.

**Hosting a room**: Backoffice → **Rooms** tab → **Create room** (pick a box count, style and optional countdown). This opens a host console at `/admin/room?code=123456` with:

- **Lock joins** — stop new players from joining mid-game
- **Start** — deals the boxes and moves everyone from the lobby into picking
- **Countdown** — arms a timer that locks all boxes when it hits zero
- **Reveal next** / **Reveal all** — opens boxes one at a time or all at once
- **Kick** — removes a player; if a seat opens up in the lobby, the earliest spectator is promoted
- **Close** — ends the room immediately for everyone

**Joining**: players go to `/join`, enter the 6-digit code and their name, and land on `/room?code=123456`. Room codes are numeric with leading zeros kept (e.g. `007123`), unique among active (non-closed) rooms, and rate-limited (10 failed join attempts per IP per 5 minutes, then a 429). A room closes on its own if left idle: 2 hours in the lobby or mid-game, 30 minutes after it finishes.

**Seats and spectators**: a room has as many seats as boxes. Once every seat is taken, later joiners watch as spectators — they see the shared board and cursors but can't pick. A room plays one round; to play again the host creates a new room.

**Reveal and stock**: only locked (claimed) boxes take prize stock and get a claim code when revealed; boxes nobody picked are opened for show with no draw recorded. Reconnecting (same browser, same room) restores your seat and any box you'd already locked. Room wins never count against a visitor's solo plays-per-visitor limit — that's a separate budget from the `/` game.

Rooms reuse the same 5 box styles as solo play (gift, card, suitcase, chest, egg), chosen per room at creation.

## Project layout

```
server/
  index.js    entry point (env config)
  app.js      Express app: public + admin API, auth, validation
  draw.js     box filling, weighted picks, odds estimation
  db.js       Postgres (pg) or embedded PGlite connection
  store.js    schema, migrations and all SQL queries
  realtime.js Socket.IO wiring: room:join, cursor relay, game:action, host:action
  rooms/      RoomService (room/player bookkeeping), room codes, constants
  games/      game plugins (mysteryBox) — dealing, locking, revealing, per-viewer views
  httpError.js, validate.js, cookies.js, codes.js, prizeView.js, ratelimit.js   shared helpers
public/
  index.html, css/app.css, js/app.js, js/fx.js, js/boxes.js   the solo game
  join.html, room.html, js/join.js, js/room.js, js/board.js, css/room.css   player room pages
  admin/                                         the backoffice, Rooms tab and host console (room.html/room.js)
api/index.js  Vercel serverless entry point (solo mode only)
vercel.json   Vercel routing
test/
  api.test.js, rooms.test.js
```

## Deploying

Rooms need a long-running Node process (WebSockets for Socket.IO), so they only work on a host that runs `npm start` continuously, such as Railway. Vercel's `api/index.js` is a serverless function with no persistent socket connection, so a Vercel deployment serves solo play (`/`) only — the Rooms tab, `/join` and `/room` won't work there until it's moved to a long-running host.

### Vercel + Railway Postgres

1. **Create the database.** In Railway, create a project and add **PostgreSQL**. Open its **Variables** tab and copy `DATABASE_PUBLIC_URL`. Use the public one: the plain `DATABASE_URL` uses Railway's private network, which Vercel can't reach.
2. **Import the repo into Vercel.** Framework preset and output directory come from `vercel.json`, so leave the defaults.
3. **Add environment variables** in Vercel → Project → Settings → Environment Variables:
   - `DATABASE_URL` = the Railway public URL from step 1
   - `ADMIN_PASSWORD` = a strong password
4. **Deploy.** Tables are created and the sample prizes seeded automatically on the first request.

Tips:

- If the connection fails with a certificate error, append `?sslmode=no-verify` to `DATABASE_URL`.
- Every game action makes a few database queries, so put Vercel's function region (Settings → Functions) close to your Railway region.

Any other Postgres works the same way: Neon or Supabase from the Vercel Marketplace, or your own.

### Any Node host (Railway, Render, a VPS, …)

Run `npm start` with `DATABASE_URL` and `ADMIN_PASSWORD` set. On Railway you can run the app in the same project as the database and use the private `DATABASE_URL`.
