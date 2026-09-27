'use strict';

const { HttpError } = require('../httpError');
const { str, int } = require('../validate');
const { STYLES } = require('./constants');
const { roomCode } = require('./codes');

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

  /**
   * The same `viewer` object is shared between `socket.data.viewer` (used by realtime.js's
   * cursor/game-action gates) and this registry, so mutating it here updates both in one place —
   * needed when a spectator is promoted to a player while already connected.
   */
  _updateCachedRole(roomId, playerId, role) {
    const map = this.roomSockets.get(roomId);
    if (!map) return;
    for (const viewer of map.values()) if (viewer.playerId === playerId) viewer.role = role;
  }

  // ---------- admin: create / list / close ----------

  async createRoom(opts = {}) {
    const settings = await this.store.getSettings();
    const style = opts.style !== undefined ? str(opts.style, 'style', { max: 20, required: true }) : settings.boxStyle;
    if (!STYLES.includes(style)) throw new HttpError(400, `style must be one of: ${STYLES.join(', ')}`);
    const boxCount = opts.boxCount !== undefined ? int(opts.boxCount, 'boxCount', 2, 12) : settings.boxCount;
    let countdownSeconds = null;
    if (opts.countdownSeconds !== undefined && opts.countdownSeconds !== null) {
      countdownSeconds = int(opts.countdownSeconds, 'countdownSeconds', 5, 120);
    }

    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const room = await this.store.createRoom({ code: roomCode(), style, boxCount, countdownSeconds });
      if (room) return this._toSummary(room, { playerCount: 0, spectatorCount: 0 });
    }
    throw new HttpError(500, 'Could not allocate a room code — please try again');
  }

  async listRooms() {
    const rows = await this.store.listActiveRooms();
    return rows.map((r) => this._toSummary(r, r));
  }

  async closeRoomByCode(code) {
    const room = await this.store.getRoomByCode(code);
    if (!room) throw new HttpError(404, 'Room not found');
    await this._closeRoomInternal(room.id);
  }

  async closeRoom(roomId) {
    const room = await this.store.getRoom(roomId);
    if (!room) throw new HttpError(404, 'Room not found');
    await this._closeRoomInternal(roomId);
  }

  async _closeRoomInternal(roomId) {
    this._clearCountdownTimer(roomId);
    await this.store.setRoomFields(this.store.db.query, roomId, { status: 'closed', closedAt: new Date() });
    this._emit(`room:${roomId}`, 'room:closed', {});
    this.roomSockets.delete(roomId);
  }

  _toSummary(room, counts) {
    return {
      code: room.code,
      status: room.status,
      style: room.style,
      boxCount: room.boxCount,
      countdownSeconds: room.countdownSeconds,
      playerCount: counts.playerCount,
      spectatorCount: counts.spectatorCount,
      createdAt: room.createdAt,
    };
  }

  // ---------- join (rate-limited) ----------

  /**
   * At most 10 FAILED join attempts per ip per 5 minutes. Checked *before* evaluating the
   * attempt, so a blocked ip's 11th guess is refused even if the code/name would have worked —
   * otherwise the 6-digit code would stay brute-forceable through the rate limit. Only failures
   * that could plausibly be a code-guessing attempt count: a bad code format (400) or "no such
   * room" (404). 409 (name taken / room ended), 423 (joins locked) and 403 (kicked) all prove the
   * caller already has a real, live room code — counting those would let one shared venue Wi-Fi IP
   * lock out every other guest at the same party over ordinary collisions, not guessing.
   */
  async join({ code, name, visitor, ip }) {
    if (!this._joinAllowed(ip)) throw new HttpError(429, 'Too many attempts — wait a few minutes');
    try {
      return await this._join({ code, name, visitor });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 400 || err.status === 404)) this._recordJoinFailure(ip);
      throw err;
    }
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

  async _join({ code, name: rawName, visitor }) {
    if (!/^\d{6}$/.test(code || '')) throw new HttpError(400, 'Invalid room code');
    const name = str(rawName, 'Name', { max: 20, required: true });

    const room = await this.store.getRoomByCodeAny(code);
    if (!room) throw new HttpError(404, 'Room not found');
    if (room.status === 'closed') throw new HttpError(409, 'This room has ended');

    const result = await this.store.db.tx(async (q) => {
      const fresh = await this.store.lockRoom(q, room.id);
      // Re-check under the lock: the room could have been closed between the read above and here.
      if (fresh.status === 'closed') throw new HttpError(409, 'This room has ended');
      const players = await this.store.listPlayers(room.id, q);
      const existing = players.find((p) => p.visitor === visitor);

      if (existing) {
        if (existing.kicked) throw new HttpError(403, 'You were removed from this room');
        return { code: fresh.code, playerId: existing.id, role: existing.role };
      }

      if (fresh.joinLocked) throw new HttpError(423, 'This room is not accepting new players');
      if (players.some((p) => !p.kicked && p.name.toLowerCase() === name.toLowerCase())) {
        throw new HttpError(409, 'That name is taken');
      }

      const playerCount = players.filter((p) => p.role === 'player' && !p.kicked).length;
      const role = fresh.status === 'finished' ? 'spectator' : playerCount < fresh.boxCount ? 'player' : 'spectator';
      const inserted = await this.store.insertPlayer(q, { roomId: room.id, visitor, name, role });
      return { code: fresh.code, playerId: inserted.id, role: inserted.role };
    });

    await this.store.touchRoom(room.id);
    await this._broadcastSafe(room.id);
    return result;
  }

  // ---------- kick / lock joins ----------

  /**
   * Kicking (in the lobby) can free a seat that a waiting spectator should be promoted into; that
   * read-check-promote sequence must be race-free against a concurrent kick or the room's own
   * status changing mid-flight, so — mirroring `_join` above — it all runs under `lockRoom` inside
   * one transaction, with every read/write inside going through `q`.
   */
  async kick(roomId, playerId) {
    let promotedId = null;
    await this.store.db.tx(async (q) => {
      const fresh = await this.store.lockRoom(q, roomId);
      const player = await this.store.kickPlayer(q, roomId, playerId);
      if (!player) throw new HttpError(404, 'Player not found');

      if (fresh && fresh.status === 'lobby') {
        const players = await this.store.listPlayers(roomId, q);
        const activePlayers = players.filter((p) => !p.kicked && p.role === 'player').length;
        // Only promote if the kick actually freed a seat — kicking a spectator, or a player who was
        // already kicked, must never push the player count past boxCount.
        if (activePlayers < fresh.boxCount) {
          const spectators = players
            .filter((p) => !p.kicked && p.role === 'spectator')
            .sort((a, b) => a.joinOrder - b.joinOrder);
          if (spectators.length > 0) {
            await this.store.setPlayerRole(q, spectators[0].id, 'player');
            promotedId = spectators[0].id;
          }
        }
      }
    });

    if (promotedId) {
      // The promoted player's already-connected sockets cache their old role (see registerSocket);
      // update it in place so `me.role` and the cursor/game-action gates reflect the promotion
      // immediately, without waiting for a reconnect.
      this._updateCachedRole(roomId, promotedId, 'player');
    }

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
    const [players, boxes, prizesList, settings] = await Promise.all([
      this.store.listPlayers(roomId),
      this.store.listRoomBoxes(roomId),
      this.store.listPrizes(),
      this.store.getSettings(),
    ]);
    const drawIds = [...new Set(boxes.filter((b) => b.revealedAt && b.drawId).map((b) => b.drawId))];
    const drawCodes = await this.store.listDrawCodes(drawIds);
    const prizesById = new Map(prizesList.map((p) => [p.id, p]));
    return { room, players, boxes, drawCodes, prizesById, settings };
  }

  _viewFor(data, viewer) {
    const { room, players, settings } = data;
    const game = this.games[room.game];

    const connectedIds = new Set();
    const socketMap = this.roomSockets.get(room.id);
    if (socketMap) for (const v of socketMap.values()) if (v.playerId) connectedIds.add(v.playerId);

    const visiblePlayers = players.filter((p) => !p.kicked);
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
      status: room.status,
      style: room.style,
      boxCount: room.boxCount,
      title: settings.title,
      joinLocked: room.joinLocked,
      countdownEndsAt: room.countdownEndsAt ? new Date(room.countdownEndsAt).toISOString() : null,
      serverNow: new Date().toISOString(),
      players: genericPlayers,
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
