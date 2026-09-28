'use strict';

const { Server } = require('socket.io');
const { HttpError } = require('./httpError');
const { parseCookies } = require('./cookies');
const { CHAT_REACTIONS } = require('./rooms/constants');

const CURSOR_MIN_INTERVAL_MS = 50; // <=20/s per socket
const CHAT_SEND_WINDOW_MS = 10_000;
const CHAT_SEND_MAX_PER_WINDOW = 5;
const CHAT_SEND_MIN_GAP_MS = 700;
const CHAT_REACT_MIN_GAP_MS = 1_500;
const CHAT_TEXT_MAX = 200;

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

/** Trim, strip control/formatting characters, collapse to a single line. */
function sanitizeChatText(raw) {
  // eslint-disable-next-line no-control-regex
  return String(raw ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
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
    socket.data.chatSendTimes = [];
    socket.data.lastReactAt = 0;

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

        const room = await store.getRoomByCode(code);

        let viewer;
        if (payload?.as === 'host') {
          // No rate limit on this socket path (unlike the REST join), so the ordering here matters:
          // check the session BEFORE anything about the room, so an unauthenticated socket always
          // gets the same 401 regardless of whether the code is real — never a free oracle for
          // scanning codes. Once authenticated, a foreign or nonexistent room both 404 identically
          // (never leak that some other tenant's room exists), and only a room this user actually
          // owns ever reaches the type check.
          const token = cookies.mb_session;
          const user = token && (await store.getSessionUser(token));
          if (!user) throw new HttpError(401, 'Please sign in');
          if (!room) throw new HttpError(404, 'Room not found');
          if (room.ownerId !== user.id) throw new HttpError(404, 'Room not found');
          if (room.type === 'default') throw new HttpError(409, 'This room has no live board');
          viewer = { role: 'host', playerId: null };
        } else {
          // One error for "no such room", "not a member" and "no visitor cookie" alike: telling
          // them apart would let a socket scan codes for free (no rate limit here, unlike the REST
          // join), then use a confirmed-live code against the rate-limited REST endpoint.
          const notInRoom = () => new HttpError(403, 'You are not in this room');
          const visitor = cookies.mb_visitor;
          if (!visitor) throw notInRoom();
          if (!room) throw notInRoom();
          if (room.type === 'default') throw new HttpError(409, 'This room has no live board');
          const player = await store.getPlayerByVisitor(room.id, visitor);
          if (!player || player.kicked) throw notInRoom();
          viewer = { role: player.role, playerId: player.id };
        }

        socket.data.roomId = room.id;
        socket.data.viewer = viewer;
        socket.data.chatSendTimes = [];
        socket.data.lastReactAt = 0;
        socket.join(`room:${room.id}`);
        if (viewer.playerId) socket.join(`player:${viewer.playerId}`);
        rs.registerSocket(room.id, socket.id, viewer);
        await rs.broadcast(room.id);
        const history = await rs.getChatHistory(room.id, viewer.role);
        if (history) socket.emit('chat:history', history);
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

    socket.on('chat:send', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      let charged = false;
      try {
        const { roomId, viewer } = socket.data;
        if (!roomId || !viewer) throw new HttpError(403, 'You are not in this room');
        if (viewer.role === 'spectator') throw new HttpError(403, 'Watchers cannot send messages');
        const store = getStore();
        const rs = getRoomService();
        if (!store || !rs) throw new HttpError(503, 'Server is starting up — try again');

        // Business-rule refusals (chat off / room closed) take priority over the rate limiter, so
        // a message that could never be posted anyway never spends the sender's rate-limit budget
        // (and, in tests, two sends made back-to-back around a chat-off toggle can't collide with
        // the 700ms minimum gap and be misreported as rate-limited instead of chat-off).
        const room = await store.getRoom(roomId);
        if (!room) throw new HttpError(404, 'Room not found');
        if (room.status === 'closed') throw new HttpError(409, 'This room has ended');
        if (!room.settings.chatEnabled) throw new HttpError(409, 'Chat is turned off');

        const text = sanitizeChatText(payload?.text);
        if (!text) throw new HttpError(400, 'Message is empty');
        if (text.length > CHAT_TEXT_MAX) throw new HttpError(400, `Message must be ${CHAT_TEXT_MAX} characters or fewer`);

        // Per-socket rate limit: max 5 / 10s AND at least 700ms since the last one. The check and
        // the charge (push) below happen with no `await` between them, so two `chat:send` calls
        // fired back-to-back without waiting for acks can't both read the same pre-charge state —
        // whichever handler resumes first charges before the other's check can run. (An `await`
        // anywhere in between would let both interleave and both pass, which is exactly the gap
        // `cursor:move` and `chat:react` below don't have and this one, before this fix, did.)
        const now = Date.now();
        socket.data.chatSendTimes = (socket.data.chatSendTimes || []).filter((t) => now - t < CHAT_SEND_WINDOW_MS);
        const lastSendAt = socket.data.chatSendTimes[socket.data.chatSendTimes.length - 1];
        if (socket.data.chatSendTimes.length >= CHAT_SEND_MAX_PER_WINDOW || (lastSendAt && now - lastSendAt < CHAT_SEND_MIN_GAP_MS)) {
          throw new HttpError(429, 'Slow down a little');
        }
        socket.data.chatSendTimes.push(now);
        charged = true;

        let hostUser = null;
        if (viewer.role === 'host') {
          const token = cookies.mb_session;
          hostUser = token && (await store.getSessionUser(token));
          const freshRoom = hostUser && (await store.getRoom(roomId));
          if (!hostUser || !freshRoom || freshRoom.ownerId !== hostUser.id) {
            viewer.role = null;
            throw new HttpError(401, 'Please sign in');
          }
        }

        await rs.sendChatMessage(roomId, viewer, text, hostUser);
        reply({ ok: true });
      } catch (err) {
        // A charge only ever happens once validation/rate-limiting itself has passed; a later
        // failure (e.g. a revoked host session) is not the sender spamming, so refund it rather
        // than let one failed send eat into their legitimate budget.
        if (charged) socket.data.chatSendTimes.pop();
        reply(errAck(err));
      }
    });

    socket.on('chat:react', async (payload) => {
      // No ack (per protocol) — a bad/throttled reaction is just silently dropped.
      try {
        const { roomId, viewer } = socket.data;
        if (!roomId || !viewer) return;
        const emoji = payload?.emoji;
        if (!CHAT_REACTIONS.includes(emoji)) return;
        const now = Date.now();
        if (now - socket.data.lastReactAt < CHAT_REACT_MIN_GAP_MS) return;
        socket.data.lastReactAt = now;

        const store = getStore();
        const rs = getRoomService();
        if (!store || !rs) return;

        let hostName = null;
        if (viewer.role === 'host') {
          const token = cookies.mb_session;
          const user = token && (await store.getSessionUser(token));
          hostName = user?.name || null;
        }
        await rs.reactChat(roomId, viewer, emoji, hostName);
      } catch (err) {
        console.error('chat:react handling failed:', err.message);
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

        // The session cookie captured when this socket connected may since have been revoked (a
        // logout, or the room being reassigned/disabled, unlike a REST request, doesn't close an
        // already-open socket), so re-check ownership on every action instead of trusting the role
        // cached at room:join time.
        const token = cookies.mb_session;
        const user = token && (await store.getSessionUser(token));
        const freshRoom = user && (await store.getRoom(roomId));
        const authorized = Boolean(user && freshRoom && freshRoom.ownerId === user.id);
        if (!authorized) {
          viewer.role = null; // downgrade the cached role so later actions on this socket fail fast too
          throw new HttpError(401, 'Please sign in');
        }

        const type = payload?.type;
        if (type === 'start') await rs.startGame(roomId);
        else if (type === 'countdown') await rs.setCountdown(roomId, payload?.seconds);
        else if (type === 'reveal') await rs.reveal(roomId, payload?.mode);
        else if (type === 'kick') await rs.kick(roomId, payload?.playerId);
        else if (type === 'lockJoins') await rs.setJoinLocked(roomId, payload?.locked);
        else if (type === 'setBoxCount') await rs.setBoxCount(roomId, payload?.count);
        else if (type === 'chatEnabled') await rs.setChatEnabled(roomId, payload?.enabled);
        else if (type === 'chatDelete') await rs.deleteChatMessage(roomId, payload?.messageId);
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
