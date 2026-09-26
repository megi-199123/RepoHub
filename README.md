# 🎁 Mystery Box

An interactive mystery-box prize game with a backoffice for configuring prizes.

Players shuffle a set of gift boxes, pick one, and watch it burst open with confetti to reveal their prize — then see what was hiding in the other boxes. Winners get a claim code that staff can look up and mark as redeemed in the backoffice.

## Quick start

```bash
npm install
ADMIN_PASSWORD=change-me npm start
```

- Game: <http://localhost:3000>
- Backoffice: <http://localhost:3000/admin>

Requires Node.js 18+. The only runtime dependency is Express.

| Variable         | Default   | Purpose                                         |
| ---------------- | --------- | ----------------------------------------------- |
| `PORT`           | `3000`    | HTTP port                                       |
| `ADMIN_PASSWORD` | `admin`   | Backoffice password — **set this in production** |
| `DATA_DIR`       | `./data`  | Where `db.json` and uploaded images are stored  |

Run the tests with `npm test`. Use `npm run dev` to restart automatically on server changes.

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

A prize leaves the draw once its stock hits 0. When no prize is available, players see a friendly "all prizes claimed" message.

## Project layout

```
server/
  index.js    entry point (env config)
  app.js      Express app: public + admin API, auth, validation
  draw.js     box filling, weighted picks, odds estimation
  store.js    JSON-file persistence with atomic writes
public/
  index.html, css/app.css, js/app.js, js/fx.js   the game
  admin/                                         the backoffice
test/
  api.test.js
```

## Deploying

Everything is stored in `DATA_DIR`, so mount it on a persistent volume and back it up. Admin sessions and in-progress rounds are kept in memory: restarting the server signs admins out and cancels unopened rounds, but no data is lost. The app is designed to run as a single instance.
