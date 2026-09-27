'use strict';

const { Server } = require('socket.io');
const { HttpError } = require('./httpError');
const { parseCookies } = require('./cookies');

const CURSOR_MIN_INTERVAL_MS = 50; // <=20/s per socket

function errAck(err) {
  if (err instanceof HttpError) return { ok: false, error: err.message };
  console.error(err);
  return { ok: false, error: 'Something went wrong' };
}

function clamp01(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Wires the room protocol onto Socket.IO. `deps.store()` / `deps.roomService()` are getters
 * rather than plain values because `attach()` in server/app.js may run before the database (and
 * therefore the Store / RoomService) is ready; every handler below fetches them fresh at call
 * time, by which point real traffic is always guaranteed to find them present.
 */
function attachRealtime(httpServer, deps = {}) {
  const getStore = () => (typeof deps.store === 'function' ? deps.store() : deps.store);
  const getRoomService = () => (typeof deps.roomService === 'function' ? deps.roomService() : deps.roomService);

  const io = new Server(httpServer, {
    cors: false,
  });

  io.on('connection', (socket) => {
    // parseCookies is itself tolerant of a malformed value now, but this still guards the
    // connection-time setup as a whole: a handshake must never be able to crash the process.
    let cookies = {};
    try {
      cookies = parseCookies(socket.handshake.headers.cookie);
    } catch (err) {
      console.error('Cookie parsing failed for a new connection:', err.message);
    }
    socket.data.roomId = null;
    socket.data.viewer = null;
    socket.data.lastCursorAt = 0;

    const leaveCurrentRoom = () => {
      const { roomId, viewer } = socket.data;
      if (!roomId) return;
      const rs = getRoomService();
      rs?.unregisterSocket(roomId, socket.id);
      socket.leave(`room:${roomId}`);
      if (viewer?.playerId) socket.leave(`player:${viewer.playerId}`);
      socket.data.roomId = null;
      socket.data.viewer = null;
    };

    socket.on('room:join', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const code = payload?.code;
        if (!/^\d{6}$/.test(code || '')) throw new HttpError(400, 'Invalid room code');
        const store = getStore();
        const rs = getRoomService();
        if (!store || !rs) throw new HttpError(503, 'Server is starting up — try again');

        leaveCurrentRoom();

        let room;
        let viewer;
        if (payload?.as === 'host') {
          const token = cookies.mb_admin;
          const validAdmin = Boolean(token && (await store.isSessionValid(token)));
          if (!validAdmin) throw new HttpError(401, 'Please sign in');
          room = await store.getRoomByCode(code);
          if (!room) throw new HttpError(404, 'Room not found');
          viewer = { role: 'host', playerId: null };
        } else {
          // One error for "no such room", "not a member" and "no visitor cookie" alike: telling
          // them apart would let a socket scan codes for free (no rate limit here, unlike the REST
          // join), then use a confirmed-live code against the rate-limited REST endpoint.
          const notInRoom = () => new HttpError(403, 'You are not in this room');
          const visitor = cookies.mb_visitor;
          if (!visitor) throw notInRoom();
          room = await store.getRoomByCode(code);
          const player = room ? await store.getPlayerByVisitor(room.id, visitor) : null;
          if (!room || !player || player.kicked) throw notInRoom();
          viewer = { role: player.role, playerId: player.id };
        }

        socket.data.roomId = room.id;
        socket.data.viewer = viewer;
        socket.join(`room:${room.id}`);
        if (viewer.playerId) socket.join(`player:${viewer.playerId}`);
        rs.registerSocket(room.id, socket.id, viewer);
        await rs.broadcast(room.id);
        reply({ ok: true });
      } catch (err) {
        reply(errAck(err));
      }
    });

    socket.on('cursor:move', (payload) => {
      // No ack for cursor:* (per protocol), but a handler must still never crash the process.
      try {
        const { roomId, viewer } = socket.data;
        if (!roomId || !viewer || viewer.role !== 'player') return;
        const now = Date.now();
        if (now - socket.data.lastCursorAt < CURSOR_MIN_INTERVAL_MS) return; // throttle: drop extras
        socket.data.lastCursorAt = now;
        const b = payload?.b === null || payload?.b === undefined ? null : Number(payload.b);
        socket.volatile.to(`room:${roomId}`).emit('cursor', {
          playerId: viewer.playerId,
          b: Number.isFinite(b) ? b : null,
          x: clamp01(payload?.x),
          y: clamp01(payload?.y),
        });
      } catch (err) {
        console.error('cursor:move handling failed:', err.message);
      }
    });

    socket.on('cursor:hide', () => {
      try {
        const { roomId, viewer } = socket.data;
        if (!roomId || !viewer || viewer.role !== 'player') return;
        socket.to(`room:${roomId}`).emit('cursor:hide', { playerId: viewer.playerId });
      } catch (err) {
        console.error('cursor:hide handling failed:', err.message);
      }
    });

    socket.on('game:action', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const { roomId, viewer } = socket.data;
        if (!roomId || !viewer || viewer.role === 'host') throw new HttpError(403, 'Only players can act');
        const rs = getRoomService();
        if (!rs) throw new HttpError(503, 'Server is starting up — try again');
        const type = payload?.type;
        if (type === 'lock') await rs.playerLock(roomId, viewer.playerId, payload?.box);
        else if (type === 'unlock') await rs.playerUnlock(roomId, viewer.playerId);
        else throw new HttpError(400, 'Unknown action');
        reply({ ok: true });
      } catch (err) {
        reply(errAck(err));
      }
    });

    socket.on('host:action', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const { roomId, viewer } = socket.data;
        if (!roomId || !viewer || viewer.role !== 'host') throw new HttpError(403, 'Host only');
        const store = getStore();
        const rs = getRoomService();
        if (!store || !rs) throw new HttpError(503, 'Server is starting up — try again');

        // The admin session cookie captured when this socket connected may since have been
        // revoked (an admin logout, unlike a REST request, doesn't close an already-open socket),
        // so re-check it on every action instead of trusting the role cached at room:join time.
        const validAdmin = Boolean(cookies.mb_admin && (await store.isSessionValid(cookies.mb_admin)));
        if (!validAdmin) {
          viewer.role = null; // downgrade the cached role so later actions on this socket fail fast too
          throw new HttpError(401, 'Please sign in');
        }

        const type = payload?.type;
        if (type === 'start') await rs.startGame(roomId);
        else if (type === 'countdown') await rs.setCountdown(roomId, payload?.seconds);
        else if (type === 'reveal') await rs.reveal(roomId, payload?.mode);
        else if (type === 'kick') await rs.kick(roomId, payload?.playerId);
        else if (type === 'lockJoins') await rs.setJoinLocked(roomId, payload?.locked);
        else if (type === 'close') await rs.closeRoom(roomId);
        else throw new HttpError(400, 'Unknown action');
        reply({ ok: true });
      } catch (err) {
        reply(errAck(err));
      }
    });

    socket.on('disconnect', () => {
      try {
        const { roomId, viewer } = socket.data;
        if (!roomId) return;
        const rs = getRoomService();
        if (!rs) return;
        rs.unregisterSocket(roomId, socket.id);
        if (viewer?.playerId && !rs.isPlayerConnected(roomId, viewer.playerId)) {
          socket.to(`room:${roomId}`).emit('cursor:hide', { playerId: viewer.playerId });
        }
        rs.broadcast(roomId).catch((err) => console.error('Broadcast on disconnect failed:', err.message));
      } catch (err) {
        console.error('Disconnect handling failed:', err.message);
      }
    });
  });

  return { io };
}

module.exports = { attachRealtime };
