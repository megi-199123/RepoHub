'use strict';

const { HttpError } = require('../httpError');
const { str, int } = require('../validate');
const { fillBoxes } = require('../draw');
const { STYLES } = require('./constants');
const { roomCode } = require('./codes');
const { DEFAULT_ROOM_SETTINGS, DEFAULT_BOX_COUNT, DEFAULT_STYLE } = require('../store');

const SWEEP_INTERVAL_MS = 60 * 1000;
const JOIN_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const MAX_JOIN_FAILURES = 10;
const MAX_CODE_ATTEMPTS = 10;

/**
 * Owns rooms end to end: REST-facing admin/join operations, the Socket.IO-facing actions behind
 * `game:action` / `host:action`, presence tracking, and per-viewer state broadcasts. Game-specific
 * rules (dealing, locking, revealing) live in the plugin registered for `room.game` (see
 * server/games/); this class only knows the generic room/player/socket bookkeeping.
 *
 * Constructed as soon as the store is ready. `io` is plugged in later via `setIo()` once
 * server/realtime.js has created the Socket.IO server (attach() may run before or after this
 * service exists, so app.js stashes the io reference until the service is built if needed).
 * Until `setIo` is called, all outbound emits are silently dropped.
 */
class RoomService {
  constructor({ store, games, countdownMsOverride } = {}) {
    this.store = store;
    this.games = games;
    // Test-only hook: fire countdown timers after this many ms instead of waiting for the real
    // countdown length, while the stored countdown_ends_at still reflects the real duration.
    this.countdownMsOverride = countdownMsOverride ?? null;
    this.io = null;
    this.closed = false;

    /** ip -> { count, resetAt }. Per instance by construction, so separate test apps never share it. */
    this.joinFailures = new Map();
    /** roomId -> Timeout, for armed countdowns. */
    this.countdownTimers = new Map();
    /** roomId -> Map(socketId -> { role, playerId }), for presence + per-viewer broadcasts. */
    this.roomSockets = new Map();
    /** roomId -> promise, so broadcasts for the same room never overtake one another. */
    this._broadcastChains = new Map();

    this.sweepTimer = setInterval(() => {
      this.sweep().catch((err) => console.error('Room sweep failed:', err.message));
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();

    // `_joinAllowed`/`_recordJoinFailure` only ever touch the one key they're called with, so an
    // ip that stops making requests (rather than working its way back under the limit) would sit
    // in the map forever. Sweep the whole map on the same cadence as the failure window so it
    // can't grow unbounded.
    this.joinFailuresPruneTimer = setInterval(() => this._pruneJoinFailures(), JOIN_FAILURE_WINDOW_MS);
    this.joinFailuresPruneTimer.unref();

    // Re-arm countdowns that were in flight when the process last stopped. Exposed as `ready` so
    // createApp can await it before serving traffic.
    this.ready = this._rearmCountdowns().catch((err) => console.error('Countdown re-arm failed:', err.message));
  }

  setIo(io) {
    this.io = io;
  }

  /** Stops all timers so `node --test` (and a restarted server) can exit cleanly. Safe to call more than once. */
  shutdown() {
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.joinFailuresPruneTimer) clearInterval(this.joinFailuresPruneTimer);
    for (const timer of this.countdownTimers.values()) clearTimeout(timer);
    this.countdownTimers.clear();
  }

  _pruneJoinFailures() {
    const now = Date.now();
    for (const [key, entry] of this.joinFailures) {
      if (entry.resetAt <= now) this.joinFailures.delete(key);
    }
  }

  _emit(target, event, payload) {
    if (this.io) this.io.to(target).emit(event, payload);
  }

  /** Fire-and-forget broadcast (reactions): never worth buffering for a slow/disconnecting client. */
  _emitVolatile(target, event, payload) {
    if (this.io) this.io.to(target).volatile.emit(event, payload);
  }

  /** The wire shape for a chat message, shared by chat:message, chat:history and setChatEnabled's re-push. */
  _chatView(m) {
    return { id: m.id, authorRole: m.authorRole, playerId: m.playerId, name: m.name, color: m.color, avatar: m.avatar, text: m.text, createdAt: m.createdAt };
  }

  // ---------- presence ----------

  registerSocket(roomId, socketId, viewer) {
    let map = this.roomSockets.get(roomId);
    if (!map) {
      map = new Map();
      this.roomSockets.set(roomId, map);
    }
    map.set(socketId, viewer);
  }

  unregisterSocket(roomId, socketId) {
    const map = this.roomSockets.get(roomId);
    if (!map) return;
    map.delete(socketId);
    if (map.size === 0) this.roomSockets.delete(roomId);
  }

  isPlayerConnected(roomId, playerId) {
    const map = this.roomSockets.get(roomId);
    if (!map) return false;
    for (const viewer of map.values()) if (viewer.playerId === playerId) return true;
    return false;
  }

  // ---------- admin: create / list / get / update / close ----------

  async createRoom(ownerId, opts = {}) {
    const type = str(opts.type, 'type', { max: 20, required: true });
    if (!['managed', 'default'].includes(type)) throw new HttpError(400, 'type must be "managed" or "default"');

    const style = opts.style !== undefined ? str(opts.style, 'style', { max: 20, required: true }) : DEFAULT_STYLE;
    if (!STYLES.includes(style)) throw new HttpError(400, `style must be one of: ${STYLES.join(', ')}`);

    const boxCount = opts.boxCount !== undefined ? int(opts.boxCount, 'boxCount', 2, 12) : DEFAULT_BOX_COUNT;

    let countdownSeconds = null;
    if (type === 'managed' && opts.countdownSeconds !== undefined && opts.countdownSeconds !== null) {
      countdownSeconds = int(opts.countdownSeconds, 'countdownSeconds', 5, 120);
    }

    const assignment = opts.assignment !== undefined ? opts.assignment : DEFAULT_ROOM_SETTINGS.assignment;
    if (!['unique', 'weighted'].includes(assignment)) throw new HttpError(400, 'Assignment must be "unique" or "weighted"');

    const settings = {
      title: opts.title !== undefined ? str(opts.title, 'title', { max: 60, required: true }) : DEFAULT_ROOM_SETTINGS.title,
      subtitle: opts.subtitle !== undefined ? str(opts.subtitle, 'subtitle', { max: 160 }) : DEFAULT_ROOM_SETTINGS.subtitle,
      assignment,
      showPrizes: opts.showPrizes !== undefined ? Boolean(opts.showPrizes) : DEFAULT_ROOM_SETTINGS.showPrizes,
      maxPlaysPerVisitor: opts.maxPlaysPerVisitor !== undefined
        ? int(opts.maxPlaysPerVisitor, 'maxPlaysPerVisitor', 0, 1000)
        : DEFAULT_ROOM_SETTINGS.maxPlaysPerVisitor,
      // A default room has no live board to chat on at all — chatEnabled is always false there,
      // regardless of what was sent (see Addendum B2: "ignored/false for default rooms").
      chatEnabled: type === 'managed'
        ? (opts.chatEnabled !== undefined ? Boolean(opts.chatEnabled) : DEFAULT_ROOM_SETTINGS.chatEnabled)
        : false,
    };

    let copyFrom = null;
    if (opts.copyPrizesFrom) {
      copyFrom = await this.store.getOwnedRoom(ownerId, opts.copyPrizesFrom);
      if (!copyFrom) throw new HttpError(404, 'Room not found');
    }

    const status = type === 'default' ? 'open' : 'lobby';
    let room = null;
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS && !room; attempt++) {
      // eslint-disable-next-line no-await-in-loop
      room = await this.store.createRoom({ ownerId, code: roomCode(), type, status, style, boxCount, countdownSeconds, settings });
    }
    if (!room) throw new HttpError(500, 'Could not allocate a room code — please try again');

    if (copyFrom) await this.store.copyPrizes(copyFrom.id, room.id);
    else await this.store.seedDefaultPrizes(room.id);

    const counts = await this.store.roomCounts(room.id);
    return this._toSummary(room, counts);
  }

  async listRooms(ownerId, includeClosed) {
    const rows = await this.store.listRooms(ownerId, includeClosed);
    return rows.map((r) => this._toSummary(r, r));
  }

  async getRoomSummary(ownerId, id) {
    const room = await this.store.getOwnedRoom(ownerId, id);
    if (!room) throw new HttpError(404, 'Room not found');
    const counts = await this.store.roomCounts(room.id);
    return this._toSummary(room, counts);
  }

  async updateRoom(ownerId, id, body = {}) {
    const room = await this.store.getOwnedRoom(ownerId, id);
    if (!room) throw new HttpError(404, 'Room not found');
    if (room.status === 'closed') throw new HttpError(409, 'This room has ended');

    // boxCount for a managed room now has its own, later-stage rule (see setBoxCount: allowed in
    // lobby AND picking, with a re-deal there) — style/countdownSeconds/assignment stay lobby-only.
    const lobbyOnlyFields = ['style', 'countdownSeconds', 'assignment'];
    const attemptingLobbyOnly = lobbyOnlyFields.some((f) => body[f] !== undefined);
    const pastLobby = room.type === 'managed' && room.status !== 'lobby';
    if (pastLobby && attemptingLobbyOnly) throw new HttpError(409, 'This room has already started');

    const settingsPatch = {};
    if (body.title !== undefined) settingsPatch.title = str(body.title, 'title', { max: 60, required: true });
    if (body.subtitle !== undefined) settingsPatch.subtitle = str(body.subtitle, 'subtitle', { max: 160 });
    if (body.showPrizes !== undefined) settingsPatch.showPrizes = Boolean(body.showPrizes);
    if (body.maxPlaysPerVisitor !== undefined) {
      settingsPatch.maxPlaysPerVisitor = int(body.maxPlaysPerVisitor, 'maxPlaysPerVisitor', 0, 1000);
    }
    if (body.assignment !== undefined) {
      if (!['unique', 'weighted'].includes(body.assignment)) throw new HttpError(400, 'Assignment must be "unique" or "weighted"');
      settingsPatch.assignment = body.assignment;
    }
    let style;
    if (body.style !== undefined) {
      style = str(body.style, 'style', { max: 20, required: true });
      if (!STYLES.includes(style)) throw new HttpError(400, `style must be one of: ${STYLES.join(', ')}`);
    }

    let countdownSeconds;
    if (body.countdownSeconds !== undefined && room.type === 'managed') {
      countdownSeconds = body.countdownSeconds === null ? null : int(body.countdownSeconds, 'countdownSeconds', 5, 120);
    }

    // A managed room's boxCount goes through setBoxCount (its own status/seated-count checks, the
    // re-deal + lock-release in picking, and its own broadcast); everything else here is validated
    // above (so a bad style/assignment/etc. 400s before setBoxCount ever runs) and applied after.
    // A default room's boxCount has no such restriction — it's a plain column update below.
    let boxCount;
    if (body.boxCount !== undefined) {
      if (room.type === 'managed') await this.setBoxCount(room.id, body.boxCount);
      else boxCount = int(body.boxCount, 'boxCount', 2, 12);
    }

    // Same pattern as boxCount: chatEnabled for a managed room goes through setChatEnabled, which
    // broadcasts room:state (and, turning ON, re-pushes chat:history to everyone) — a plain
    // settingsPatch write here would leave already-connected sockets holding the stale value.
    // Allowed in any non-closed status (no lobby restriction); ignored for a default room, which
    // has no live board to chat on at all.
    if (body.chatEnabled !== undefined && room.type === 'managed') {
      await this.setChatEnabled(room.id, body.chatEnabled);
    }

    const updated = await this.store.updateRoomSettings(room.id, { settingsPatch, boxCount, style, countdownSeconds });
    const counts = await this.store.roomCounts(room.id);
    return this._toSummary(updated, counts);
  }

  /**
   * Live box-count change for a managed room, before the reveal locks things in. Allowed in
   * `lobby` or `picking`; anything later (`locked`/`revealing`/`finished`/`closed`) is refused.
   * Must stay >= the number of seated players (role `player`, not kicked) or refused. In `picking`,
   * re-deals `rooms.boxes` for the new count from this room's own prizes and releases every lock on
   * a box index that no longer exists — the countdown (if any) is untouched and keeps running.
   * Unchecked here: the caller (the owner-checked PUT route, or realtime.js's host:action gate)
   * must already have verified this is legitimate.
   */
  async setBoxCount(roomId, count) {
    const n = int(count, 'boxCount', 2, 12);
    await this.store.db.tx(async (q) => {
      const room = await this.store.lockRoom(q, roomId);
      if (!room) throw new HttpError(404, 'Room not found');
      if (!['lobby', 'picking'].includes(room.status)) throw new HttpError(409, 'Boxes are already locked in');

      const players = await this.store.listPlayers(roomId, q);
      const seated = players.filter((p) => p.role === 'player' && !p.kicked).length;
      if (n < seated) throw new HttpError(409, `${seated} players are seated — kick someone first`);

      if (room.status === 'picking') {
        const prizes = await this.store.listPrizes(roomId, q);
        const boxes = fillBoxes(prizes, n, room.settings.assignment);
        if (!boxes) throw new HttpError(409, 'All prizes have been claimed. Check back soon!');
        await this.store.setRoomFields(q, roomId, { boxCount: n, boxes });
        for (const p of players) {
          if (p.lockedBox !== null && p.lockedBox !== undefined && p.lockedBox >= n) {
            await this.store.clearLock(q, roomId, p.id);
          }
        }
      } else {
        await this.store.setRoomFields(q, roomId, { boxCount: n });
      }
    });
    await this.store.touchRoom(roomId);
    await this._broadcastSafe(roomId);
  }

  /** Unchecked close — the caller (sweep(), or realtime.js's host:action gate) must already have
   *  verified this is legitimate. Idempotent: closing an already-closed room still succeeds. */
  async closeRoom(roomId) {
    const room = await this.store.getRoom(roomId);
    if (!room) throw new HttpError(404, 'Room not found');
    await this._closeRoomInternal(roomId);
  }

  /** HTTP-facing: 404s on a room I don't own, before closing it. */
  async closeRoomForOwner(ownerId, id) {
    const room = await this.store.getOwnedRoom(ownerId, id);
    if (!room) throw new HttpError(404, 'Room not found');
    await this._closeRoomInternal(id);
  }

  async _closeRoomInternal(roomId) {
    this._clearCountdownTimer(roomId);
    await this.store.setRoomFields(this.store.db.query, roomId, { status: 'closed', closedAt: new Date() });
    this._emit(`room:${roomId}`, 'room:closed', {});
    this.roomSockets.delete(roomId);
  }

  _toSummary(room, counts) {
    const s = room.settings;
    return {
      id: room.id,
      code: room.code,
      type: room.type,
      status: room.status,
      title: s.title,
      subtitle: s.subtitle,
      style: room.style,
      boxCount: room.boxCount,
      countdownSeconds: room.countdownSeconds,
      assignment: s.assignment,
      showPrizes: s.showPrizes,
      maxPlaysPerVisitor: s.maxPlaysPerVisitor,
      // A default room has no live board to chat on at all — never report true for one, even if
      // its settings jsonb somehow carries a stale/legacy chatEnabled:true (belt-and-braces on top
      // of createRoom/updateRoom already forcing it to false there).
      chatEnabled: room.type === 'managed' && Boolean(s.chatEnabled),
      playerCount: counts.playerCount,
      spectatorCount: counts.spectatorCount,
      prizeCount: counts.prizeCount,
      drawCount: counts.drawCount,
      createdAt: room.createdAt,
      closedAt: room.closedAt,
    };
  }

  // ---------- public by-code endpoints (all rate-limited together) ----------

  /**
   * At most 10 FAILED attempts per ip per 5 minutes, shared by every public by-code endpoint
   * (lookup, join, default-room config/rounds/pick). Checked *before* resolving the code, so a
   * blocked ip's next guess is refused even if the code would have worked — otherwise the 6-digit
   * code would stay brute-forceable through the rate limit.
   *
   * Only a bad code format (400) or "no such room" (404) — both raised by `_resolveRoomByCode`,
   * i.e. before a real room has been found — count as a failure. Everything that can only happen
   * once a real room was found (name validation, "room ended", "hosted live", out of prizes, …) is
   * evaluated in `thenFn` and never touches the counter, however it fails.
   */
  async _limited(ip, resolveFn, thenFn) {
    if (!this._joinAllowed(ip)) throw new HttpError(429, 'Too many attempts — wait a few minutes');
    let room;
    try {
      room = await resolveFn();
    } catch (err) {
      if (err instanceof HttpError && (err.status === 400 || err.status === 404)) this._recordJoinFailure(ip);
      throw err;
    }
    return thenFn(room);
  }

  _joinAllowed(ip) {
    const entry = this.joinFailures.get(ip);
    if (!entry) return true;
    if (entry.resetAt <= Date.now()) {
      this.joinFailures.delete(ip);
      return true;
    }
    return entry.count < MAX_JOIN_FAILURES;
  }

  _recordJoinFailure(ip) {
    const now = Date.now();
    let entry = this.joinFailures.get(ip);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + JOIN_FAILURE_WINDOW_MS };
    entry.count += 1;
    this.joinFailures.set(ip, entry);
  }

  async _resolveRoomByCode(code) {
    if (!/^\d{6}$/.test(code || '')) throw new HttpError(400, 'Invalid room code');
    const room = await this.store.getRoomByCodeAny(code);
    if (!room) throw new HttpError(404, 'Room not found');
    return room;
  }

  async lookup(code, ip) {
    return this._limited(ip, () => this._resolveRoomByCode(code), (room) => {
      if (room.status === 'closed') throw new HttpError(409, 'This room has ended');
      return { code: room.code, type: room.type, title: room.settings.title };
    });
  }

  /** Resolves a code to an open `default` room, for /api/rooms/:code/config|rounds|rounds/:id/pick. */
  async resolveDefaultRoomByCode(code, ip) {
    return this._limited(ip, () => this._resolveRoomByCode(code), (room) => {
      if (room.status === 'closed') throw new HttpError(409, 'This room has ended');
      if (room.type !== 'default') throw new HttpError(409, 'This room is hosted live — join it with your name');
      return room;
    });
  }

  /**
   * Seats a PLAYER only (see `watch` below for spectating). A visitor who already holds a
   * non-kicked player row just rejoins unchanged. Otherwise — including a visitor who already
   * holds a spectator row, who gets upgraded in place — a seat must actually be free and the game
   * must not already be past picking; if not, this returns a 409 with `canWatch: true` rather than
   * silently falling back to spectating, so the caller can offer "Watch instead".
   */
  async join({ code, name, visitor, ip }) {
    return this._limited(ip, () => this._resolveRoomByCode(code), async (room) => {
      if (room.status === 'closed') throw new HttpError(409, 'This room has ended');
      if (room.type === 'default') return { code: room.code, type: 'default' };

      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!trimmed) return { code: room.code, type: 'managed', needsName: true };
      const validName = str(name, 'Name', { max: 20, required: true });

      const result = await this.store.db.tx(async (q) => {
        const fresh = await this.store.lockRoom(q, room.id);
        // Re-check under the lock: the room could have been closed between the read above and here.
        if (fresh.status === 'closed') throw new HttpError(409, 'This room has ended');
        const players = await this.store.listPlayers(room.id, q);
        const existing = players.find((p) => p.visitor === visitor);

        if (existing) {
          if (existing.kicked) throw new HttpError(403, 'You were removed from this room');
          // Already seated: idempotent rejoin, unaffected by seat/status checks below.
          if (existing.role === 'player') return { code: fresh.code, type: 'managed', playerId: existing.id, role: 'player' };
        }

        if (['revealing', 'finished'].includes(fresh.status)) {
          throw new HttpError(409, 'This game is over — you can still watch', { canWatch: true });
        }
        if (fresh.joinLocked) throw new HttpError(423, 'This room is not accepting new players');

        const seatedCount = players.filter((p) => p.role === 'player' && !p.kicked).length;
        if (seatedCount >= fresh.boxCount) {
          throw new HttpError(409, 'All seats are taken — you can still watch', { canWatch: true });
        }
        // Spectator rows never take a name that could clash — only other players can already hold one.
        if (players.some((p) => p.role === 'player' && !p.kicked && p.name.toLowerCase() === validName.toLowerCase())) {
          throw new HttpError(409, 'That name is taken');
        }

        if (existing) {
          const upgraded = await this.store.upgradeToPlayer(q, existing.id, validName);
          return { code: fresh.code, type: 'managed', playerId: upgraded.id, role: 'player' };
        }
        const inserted = await this.store.insertPlayer(q, { roomId: room.id, visitor, name: validName, role: 'player' });
        return { code: fresh.code, type: 'managed', playerId: inserted.id, role: 'player' };
      });

      await this.store.touchRoom(room.id);
      await this._broadcastSafe(room.id);
      return result;
    });
  }

  /**
   * Creates (or reuses) a spectator row for this visitor — never seats a player, never subject to
   * the seat cap, `joinLocked`, or the room being past picking. An existing player row is left
   * untouched (`role: 'player'` is returned, not downgraded). A `default` room has no live board to
   * watch at all.
   */
  async watch(code, visitor, ip) {
    return this._limited(ip, () => this._resolveRoomByCode(code), async (room) => {
      if (room.status === 'closed') throw new HttpError(409, 'This room has ended');
      if (room.type === 'default') throw new HttpError(409, 'This room has no live board');

      const result = await this.store.db.tx(async (q) => {
        const fresh = await this.store.lockRoom(q, room.id);
        if (fresh.status === 'closed') throw new HttpError(409, 'This room has ended');
        const players = await this.store.listPlayers(room.id, q);
        const existing = players.find((p) => p.visitor === visitor);

        if (existing) {
          if (existing.kicked) throw new HttpError(403, 'You were removed from this room');
          return { code: fresh.code, type: 'managed', role: existing.role };
        }

        const inserted = await this.store.insertPlayer(q, { roomId: room.id, visitor, name: 'Watcher', role: 'spectator' });
        return { code: fresh.code, type: 'managed', role: inserted.role };
      });

      await this.store.touchRoom(room.id);
      await this._broadcastSafe(room.id);
      return result;
    });
  }

  // ---------- kick / lock joins ----------

  /**
   * Kicking never auto-promotes a spectator into the freed seat (see A2) — a spectator who wants to
   * play sends a fresh `join` with a name once a seat is actually free. Still runs under `lockRoom`
   * for the same race-safety as every other room mutation.
   */
  async kick(roomId, playerId) {
    await this.store.db.tx(async (q) => {
      await this.store.lockRoom(q, roomId);
      const player = await this.store.kickPlayer(q, roomId, playerId);
      if (!player) throw new HttpError(404, 'Player not found');
    });

    // Detach the kicked player's sockets from the room so they stop receiving updates and can't
    // relay cursor/game actions into it, then tell them they were kicked.
    const map = this.roomSockets.get(roomId);
    if (map) {
      for (const [socketId, viewer] of [...map]) {
        if (viewer.playerId !== playerId) continue;
        map.delete(socketId);
        const socket = this.io?.sockets?.sockets?.get(socketId);
        if (socket) {
          socket.leave(`room:${roomId}`);
          socket.data.roomId = null;
          socket.data.viewer = null;
        }
      }
    }
    this._emit(`player:${playerId}`, 'room:kicked', {});

    await this.store.touchRoom(roomId);
    await this._broadcastSafe(roomId);
  }

  async setJoinLocked(roomId, locked) {
    const room = await this.store.getRoom(roomId);
    if (!room) throw new HttpError(404, 'Room not found');
    await this.store.setRoomFields(this.store.db.query, roomId, { joinLocked: Boolean(locked) });
    await this.store.touchRoom(roomId);
    await this._broadcastSafe(roomId);
  }

  // ---------- chat ----------

  /** Last 50 non-deleted messages, or null if there's nothing to push (room missing, or chat
   *  currently off and the viewer isn't the host — hosts can always review history to moderate). */
  async getChatHistory(roomId, viewerRole) {
    const room = await this.store.getRoom(roomId);
    if (!room) return null;
    if (!room.settings.chatEnabled && viewerRole !== 'host') return null;
    const rows = await this.store.listRecentMessages(roomId, 50);
    return rows.map((m) => this._chatView(m));
  }

  /**
   * `viewer` is the sender: `{role:'host'|'player', playerId}`. A spectator must never reach here
   * (refused earlier, in realtime.js, before the per-socket rate limit is even charged). `hostUser`
   * is the already session-checked owner, resolved by the caller (mirrors host:action's re-check).
   */
  async sendChatMessage(roomId, viewer, text, hostUser) {
    const room = await this.store.getRoom(roomId);
    if (!room) throw new HttpError(404, 'Room not found');
    if (room.status === 'closed') throw new HttpError(409, 'This room has ended');
    if (!room.settings.chatEnabled) throw new HttpError(409, 'Chat is turned off');

    let authorRole;
    let playerId = null;
    let name;
    let color = null;
    let avatar = null;
    if (viewer.role === 'host') {
      authorRole = 'host';
      name = hostUser?.name || 'Host';
    } else {
      authorRole = 'player';
      const player = await this.store.getPlayerById(viewer.playerId);
      if (!player || player.kicked || player.roomId !== roomId) throw new HttpError(403, 'You are not in this room');
      playerId = player.id;
      name = player.name;
      color = player.color;
      avatar = player.avatar;
    }

    const message = await this.store.insertMessage({ roomId, playerId, authorRole, name, color, avatar, text });
    const view = this._chatView(message);
    this._emit(`room:${roomId}`, 'chat:message', view);
    return view;
  }

  /** Never throws — a reaction is ephemeral and silently a no-op if the room/chat isn't there. */
  async reactChat(roomId, viewer, emoji, hostName) {
    const room = await this.store.getRoom(roomId);
    if (!room || room.status === 'closed' || !room.settings.chatEnabled) return;
    let name = null;
    if (viewer.role === 'host') {
      name = hostName || null;
    } else if (viewer.role === 'player' && viewer.playerId) {
      // A spectator's own row carries only the internal watch-placeholder name ("Watcher") — never
      // show that in the UI as if it were a real display name; watchers react anonymously.
      const player = await this.store.getPlayerById(viewer.playerId);
      name = player ? player.name : null;
    }
    this._emitVolatile(`room:${roomId}`, 'chat:reaction', { emoji, name });
  }

  async deleteChatMessage(roomId, messageId) {
    const room = await this.store.getRoom(roomId);
    if (!room) throw new HttpError(404, 'Room not found');
    const deleted = await this.store.markMessageDeleted(roomId, messageId);
    if (!deleted) throw new HttpError(404, 'Message not found');
    this._emit(`room:${roomId}`, 'chat:deleted', { id: deleted.id });
  }

  async setChatEnabled(roomId, enabled) {
    const room = await this.store.getRoom(roomId);
    if (!room) throw new HttpError(404, 'Room not found');
    const value = Boolean(enabled);
    await this.store.updateRoomSettings(roomId, { settingsPatch: { chatEnabled: value } });
    await this.store.touchRoom(roomId);
    await this._broadcastSafe(roomId);
    if (value) {
      // Turning ON: everyone currently connected gets caught up, regardless of role.
      const history = await this.getChatHistory(roomId, 'host');
      if (history) this._emit(`room:${roomId}`, 'chat:history', history);
    }
  }

  // ---------- game actions ----------

  async startGame(roomId) {
    const room = await this._loadRoomOrThrow(roomId);
    await this.games[room.game].start({ store: this.store }, room);
    await this.store.touchRoom(roomId);
    await this._broadcastSafe(roomId);
  }

  async playerLock(roomId, playerId, box) {
    const room = await this._loadRoomOrThrow(roomId);
    await this.games[room.game].actions.lock({ store: this.store, room }, playerId, box);
    await this.store.touchRoom(roomId);
    await this._broadcastSafe(roomId);
  }

  async playerUnlock(roomId, playerId) {
    const room = await this._loadRoomOrThrow(roomId);
    await this.games[room.game].actions.unlock({ store: this.store, room }, playerId);
    await this.store.touchRoom(roomId);
    await this._broadcastSafe(roomId);
  }

  async setCountdown(roomId, seconds) {
    const room = await this._loadRoomOrThrow(roomId);
    const endsAt = await this.games[room.game].actions.countdown({ store: this.store, room }, seconds);
    this._armCountdownTimer(roomId, endsAt);
    await this.store.touchRoom(roomId);
    await this._broadcastSafe(roomId);
  }

  async reveal(roomId, mode) {
    const room = await this._loadRoomOrThrow(roomId);
    this._clearCountdownTimer(roomId);
    await this.games[room.game].actions.reveal({ store: this.store, room }, mode);
    await this.store.touchRoom(roomId);
    await this._broadcastSafe(roomId);
  }

  async _loadRoomOrThrow(roomId) {
    const room = await this.store.getRoom(roomId);
    if (!room) throw new HttpError(404, 'Room not found');
    return room;
  }

  // ---------- countdown timers ----------

  _armCountdownTimer(roomId, endsAt) {
    this._clearCountdownTimer(roomId);
    const delay = this.countdownMsOverride != null
      ? this.countdownMsOverride
      : Math.max(0, new Date(endsAt).getTime() - Date.now());
    const timer = setTimeout(() => {
      this._onCountdownFire(roomId).catch((err) => console.error('Countdown fire failed:', err.message));
    }, delay);
    timer.unref();
    this.countdownTimers.set(roomId, timer);
  }

  _clearCountdownTimer(roomId) {
    const timer = this.countdownTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.countdownTimers.delete(roomId);
    }
  }

  async _onCountdownFire(roomId) {
    if (this.closed) return;
    this.countdownTimers.delete(roomId);
    const room = await this.store.getRoom(roomId);
    if (!room) return;
    const game = this.games[room.game];
    const changed = await game.onCountdownEnd({ store: this.store }, room);
    if (changed) {
      await this.store.touchRoom(roomId);
      await this._broadcastSafe(roomId);
    }
  }

  async _rearmCountdowns() {
    const rooms = await this.store.activeCountdowns();
    for (const room of rooms) this._armCountdownTimer(room.id, room.countdownEndsAt);
  }

  // ---------- sweeping ----------

  async sweep() {
    if (this.closed) return;
    const rooms = await this.store.roomsToSweep();
    for (const room of rooms) await this._closeRoomInternal(room.id);
  }

  // ---------- views ----------

  async _loadRoomData(roomId) {
    const room = await this.store.getRoom(roomId);
    if (!room) return null;
    const [players, boxes, prizesList] = await Promise.all([
      this.store.listPlayers(roomId),
      this.store.listRoomBoxes(roomId),
      this.store.listPrizes(roomId),
    ]);
    const drawIds = [...new Set(boxes.filter((b) => b.revealedAt && b.drawId).map((b) => b.drawId))];
    const drawCodes = await this.store.listDrawCodes(drawIds);
    const prizesById = new Map(prizesList.map((p) => [p.id, p]));
    return { room, players, boxes, drawCodes, prizesById };
  }

  _viewFor(data, viewer) {
    const { room, players } = data;
    const game = this.games[room.game];

    const connectedIds = new Set();
    const socketMap = this.roomSockets.get(room.id);
    if (socketMap) for (const v of socketMap.values()) if (v.playerId) connectedIds.add(v.playerId);

    // room:state's `players` roster is seated players only — spectators get their own count (A2).
    const visiblePlayers = players.filter((p) => !p.kicked && p.role === 'player');
    const spectatorCount = players.filter((p) => !p.kicked && p.role === 'spectator').length;
    const genericPlayers = visiblePlayers.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      avatar: p.avatar,
      role: p.role,
      connected: connectedIds.has(p.id),
      lockedBox: p.lockedBox ?? null,
    }));

    const gameOut = game.view({ ...data, players: visiblePlayers }, viewer);

    let me = { id: viewer.role === 'host' ? null : viewer.playerId || null, role: viewer.role, claimCode: null };
    if (gameOut.me) me = { ...me, ...gameOut.me };

    return {
      code: room.code,
      type: room.type,
      status: room.status,
      style: room.style,
      boxCount: room.boxCount,
      title: room.settings.title,
      chatEnabled: room.type === 'managed' && Boolean(room.settings.chatEnabled),
      joinLocked: room.joinLocked,
      countdownEndsAt: room.countdownEndsAt ? new Date(room.countdownEndsAt).toISOString() : null,
      serverNow: new Date().toISOString(),
      players: genericPlayers,
      spectatorCount,
      boxes: gameOut.boxes,
      me,
    };
  }

  async buildView(roomId, viewer) {
    const data = await this._loadRoomData(roomId);
    if (!data) return null;
    return this._viewFor(data, viewer);
  }

  /**
   * `_loadRoomData` awaits several queries, so two calls for the same room can interleave; without
   * serializing, a later mutation's broadcast could be built (and land) before an earlier one's,
   * making the earlier change vanish from clients until the next update. Chaining each room's
   * broadcasts onto the previous one (regardless of whether it succeeded) fixes that ordering.
   */
  broadcast(roomId) {
    const prev = this._broadcastChains.get(roomId) || Promise.resolve();
    const run = prev.then(
      () => this._doBroadcast(roomId),
      () => this._doBroadcast(roomId),
    );
    const cleanup = () => {
      if (this._broadcastChains.get(roomId) === run) this._broadcastChains.delete(roomId);
    };
    run.then(cleanup, cleanup);
    this._broadcastChains.set(roomId, run);
    return run;
  }

  async _doBroadcast(roomId) {
    if (this.closed) return;
    const socketMap = this.roomSockets.get(roomId);
    if (!socketMap || socketMap.size === 0) return;
    const data = await this._loadRoomData(roomId);
    if (!data) return;
    for (const [socketId, viewer] of socketMap) {
      const view = this._viewFor(data, viewer);
      this.io?.to(socketId).emit('room:state', view);
    }
  }

  async _broadcastSafe(roomId) {
    try {
      await this.broadcast(roomId);
    } catch (err) {
      console.error('Broadcast failed:', err.message);
    }
  }
}

module.exports = { RoomService };
