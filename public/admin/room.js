/* Host console for one room: connects as `as: 'host'`, renders the shared board (read-only, no
 * hand of its own) via window.Board, and drives the room through `host:action`. No page global is
 * exported — this is a page script, not a shared module.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const { startStars } = window.FX;

  const els = {
    stars: $('stars'),
    hostCode: $('host-code'),
    copyInvite: $('copy-invite'),
    reconnectBanner: $('reconnect-banner'),
    statusText: $('status-text'),
    countdownPill: $('countdown-pill'),
    srAnnounce: $('sr-announce'),
    lockSummary: $('lock-summary'),
    boxes: $('boxes'),
    resultsList: $('results-list'),
    playerList: $('player-list'),
    playerEmpty: $('player-empty'),
    lockJoins: $('lock-joins'),
    btnStart: $('btn-start'),
    countdownSeconds: $('countdown-seconds'),
    btnCountdown: $('btn-countdown'),
    btnRevealNext: $('btn-reveal-next'),
    btnRevealAll: $('btn-reveal-all'),
    btnClose: $('btn-close'),
    endedScreen: $('ended-screen'),
    toast: $('toast'),
    confirmDialog: $('confirm-dialog'),
    confirmTitle: $('confirm-title'),
    confirmText: $('confirm-text'),
    confirmOk: $('confirm-ok'),
  };

  const STATUS_TEXT = {
    lobby: 'Waiting to start…',
    picking: 'Players are picking boxes…',
    locked: "Time's up — ready to reveal.",
    revealing: 'Revealing boxes…',
    finished: 'All boxes revealed.',
    closed: 'This room has ended.',
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const params = new URLSearchParams(location.search);
  const code = (params.get('code') || '').trim();
  if (!/^\d{6}$/.test(code)) {
    location.href = '/admin#rooms';
    return;
  }
  els.hostCode.textContent = code;

  let latestView = null;
  let ended = false;
  let skewMs = 0;
  let fallbackCountdownSeconds = 15;
  let receivedFirstState = false;
  let socketConnected = false;
  let awaitingRejoinBanner = false;
  // C3 (browser audit): every host action button now stays disabled from the moment it's
  // clicked until its own ack (or a timeout) comes back — a `room:state` snapshot arriving in
  // between must NOT re-enable it, or a fast double-tap on reveal can still open two boxes.
  const pending = new Set();

  let toastTimer;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3200);
  }

  function showReconnectBanner(text) {
    if (!text) { els.reconnectBanner.hidden = true; return; }
    els.reconnectBanner.textContent = text;
    els.reconnectBanner.hidden = false;
  }

  let announcedFor = null;
  let announcedMilestones = null;
  function announce(message) {
    els.srAnnounce.textContent = '';
    requestAnimationFrame(() => { els.srAnnounce.textContent = message; });
  }

  /** Fire one host action, tracked in `pending` under `key` for the duration of the round
   *  trip so `applyControlsDisabled()` keeps the triggering button(s) disabled the whole time
   *  — not just until the next room:state, which can arrive before the ack does.
   *  `onSettle(err, res)`, if given, runs after the pending/toast handling above, whether the
   *  action failed, timed out, or succeeded — for callers that need to react either way (e.g.
   *  reverting an optimistically-toggled checkbox). */
  function hostAction(key, payload, onSettle) {
    if (pending.has(key)) return;
    pending.add(key);
    applyControlsDisabled();
    socket.timeout(8000).emit('host:action', payload, (err, res) => {
      pending.delete(key);
      applyControlsDisabled();
      if (err) { toast('That action timed out — please try again.'); if (onSettle) onSettle(err, res); return; }
      if (res && res.ok === false) toast(res.error);
      if (onSettle) onSettle(err, res);
    });
  }

  function confirmDialog({ title, text, ok = 'Confirm' }) {
    els.confirmTitle.textContent = title;
    els.confirmText.textContent = text;
    els.confirmOk.textContent = ok;
    els.confirmDialog.returnValue = '';
    els.confirmDialog.showModal();
    return new Promise((resolve) => els.confirmDialog.addEventListener('close', () => resolve(els.confirmDialog.returnValue === 'ok'), { once: true }));
  }

  const socket = io({ transports: ['websocket', 'polling'] });

  const board = window.Board.create(els.boxes, {
    interactive: false,
    showHands: true,
    getSelfId: () => null,
  });

  function goToRooms() {
    if (ended) return;
    ended = true;
    location.href = '/admin#rooms';
  }

  function joinRoom() {
    socket.emit('room:join', { code, as: 'host' }, (res) => {
      if (ended) return;
      if (!res || !res.ok) goToRooms();
    });
  }

  socket.on('connect', () => {
    socketConnected = true;
    applyControlsDisabled();
    if (!ended) joinRoom();
  });
  socket.on('room:state', handleState);
  socket.on('cursor', (msg) => board.handCursor(msg));
  socket.on('cursor:hide', (msg) => board.hideCursor(msg.playerId));
  // N14 (code audit): a native <dialog> "Remove player?"/"Close this room?" confirmation is
  // in the browser's top layer — it would otherwise stay open and interactive on top of the
  // takeover screen underneath it if the room closes while it's up.
  socket.on('room:closed', () => {
    ended = true;
    if (els.confirmDialog.open) els.confirmDialog.close();
    socket.disconnect();
    els.endedScreen.hidden = false;
    const card = els.endedScreen.querySelector('.takeover-card');
    if (card) card.focus();
  });
  // B.4: visible connect/reconnect feedback — mirrors public/js/room.js.
  socket.on('disconnect', (reason) => {
    socketConnected = false;
    // N6 (code audit): this used to only clear on `disconnect`, not on `connect` — so the
    // moment the transport reconnected, every gate below saw `receivedFirstState` still true
    // from before the drop and re-enabled every control using stale pre-disconnect state,
    // before this connection's `room:join` had actually landed server-side. A click in that
    // window came back as a confusing "Host only" 403 instead of "still reconnecting".
    receivedFirstState = false;
    applyControlsDisabled();
    if (ended) return;
    awaitingRejoinBanner = true;
    showReconnectBanner('Connection lost — reconnecting…');
    if (reason === 'io server disconnect') socket.connect();
  });
  socket.on('connect_error', () => {
    if (ended) return;
    awaitingRejoinBanner = true;
    showReconnectBanner('Connection problem — retrying…');
  });
  socket.io.on('reconnect_attempt', () => {
    if (!ended) showReconnectBanner('Reconnecting…');
  });
  socket.io.on('reconnect_failed', () => {
    if (!ended) showReconnectBanner('Unable to reconnect. Please refresh the page.');
  });

  function handleState(view) {
    if (awaitingRejoinBanner) { awaitingRejoinBanner = false; showReconnectBanner(null); }
    receivedFirstState = true;
    skewMs = new Date(view.serverNow).getTime() - Date.now();
    latestView = view;
    board.render(view);
    renderHeader(view);
    renderStatus(view);
    renderPlayers(view);
    renderResults(view);
    renderControls(view);
  }

  function renderHeader(view) {
    document.title = `Host — Room ${view.code}`;
    els.hostCode.textContent = view.code;
  }

  let lastStatusText = null;
  function renderStatus(view) {
    // C2 (code audit): don't re-announce the same sentence to the aria-live region on every
    // room:state (locks/picks fire this just as often as an actual status change).
    const text = STATUS_TEXT[view.status] || '';
    if (text !== lastStatusText) {
      lastStatusText = text;
      els.statusText.textContent = text;
    }
  }

  function renderPlayers(view) {
    els.playerEmpty.hidden = view.players.length > 0;
    els.playerList.replaceChildren(
      ...view.players.map((p) => {
        const locked = p.lockedBox !== null && p.lockedBox !== undefined;
        // N17 (code review): each kick button tracks its OWN pending state (`kick:<id>` in the
        // shared `pending` set) so a click on one player's ✕ only disables that button — every
        // other kick button stays fully usable while this one's ack is still in flight.
        const kicking = pending.has(`kick:${p.id}`);
        const li = document.createElement('li');
        li.className = `host-player${p.connected ? ' is-connected' : ''}`;
        li.style.setProperty('--chip-color', p.color);
        li.innerHTML = `
          <span class="host-player-avatar">${esc(p.avatar)}</span>
          <span class="host-player-dot" aria-hidden="true"></span>
          <span class="sr-only">${p.connected ? 'Online' : 'Away'}</span>
          <span class="host-player-name" title="${esc(p.name)}">${esc(p.name)}</span>
          ${p.role === 'spectator' ? '<span class="chip info">watching</span>' : ''}
          ${locked ? '<span class="chip ok">locked</span>' : ''}
          <button class="icon-btn danger host-kick${kicking ? ' is-kicking' : ''}" type="button" data-id="${esc(p.id)}" data-name="${esc(p.name)}" title="${kicking ? 'Kicking…' : `Kick ${esc(p.name)}`}" aria-label="${kicking ? `Kicking ${esc(p.name)}…` : `Kick ${esc(p.name)}`}"${kicking ? ' disabled' : ''}>${kicking ? 'Kicking…' : '✕'}</button>
        `;
        return li;
      }),
    );

    const seated = view.players.filter((p) => p.role === 'player');
    if (['picking', 'locked', 'revealing'].includes(view.status) && seated.length > 0) {
      const lockedCount = seated.filter((p) => p.lockedBox !== null && p.lockedBox !== undefined).length;
      els.lockSummary.textContent = `${lockedCount} of ${seated.length} locked in`;
      els.lockSummary.hidden = false;
    } else {
      els.lockSummary.hidden = true;
    }
  }

  els.playerList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.host-kick');
    if (!btn) return;
    const playerId = btn.dataset.id;
    const key = `kick:${playerId}`;
    if (pending.has(key)) return;
    const ok = await confirmDialog({ title: `Remove ${btn.dataset.name}?`, text: 'They will be disconnected from this room right away.', ok: 'Kick' });
    if (!ok || pending.has(key)) return;
    hostAction(key, { type: 'kick', playerId }, () => { if (latestView) renderPlayers(latestView); });
    // hostAction adds `key` to `pending` synchronously before the emit — re-render right away
    // so this button flips to "Kicking…" immediately instead of waiting for the next room:state.
    if (latestView) renderPlayers(latestView);
  });

  function renderResults(view) {
    const show = view.status === 'revealing' || view.status === 'finished';
    els.resultsList.hidden = !show;
    if (!show) return;
    const playersById = new Map(view.players.map((p) => [p.id, p]));
    const rows = view.boxes.filter((b) => b.revealed && b.playerId).sort((a, b) => a.box - b.box);
    els.resultsList.replaceChildren(
      ...rows.map((b) => {
        const owner = playersById.get(b.playerId);
        const li = document.createElement('li');
        li.className = 'result-row';
        if (owner) li.style.setProperty('--row-color', owner.color);
        const prizeName = b.prize ? b.prize.name : 'Out of stock';
        const emoji = b.prize ? b.prize.emoji || '🎁' : '❔';
        li.innerHTML = `<span class="result-avatar">${esc(owner ? owner.avatar : '🙂')}</span><span class="result-name">${esc(owner ? owner.name : 'Someone')}</span><span class="result-emoji">${esc(emoji)}</span><span class="result-prize">${esc(prizeName)}</span>`;
        return li;
      }),
    );
  }

  /** What the current room status alone allows (ignores connection/pending gates below). */
  function computeAllowed(view) {
    if (!view) return { start: false, countdown: false, reveal: false, close: false, lockJoins: false };
    const status = view.status;
    return {
      start: status === 'lobby',
      countdown: status === 'picking',
      reveal: ['picking', 'locked', 'revealing'].includes(status),
      close: status !== 'closed',
      lockJoins: status !== 'finished' && status !== 'closed',
    };
  }

  /** C3 (browser audit): every control here is gated on three things at once — the socket
   *  has to be connected, the host has to have actually joined the room (its first
   *  room:state), and the room's current status has to allow the action — plus each button
   *  individually stays disabled while its own action is still in flight (`pending`). Called
   *  after every room:state AND after every pending/connection change, never the reverse. */
  function applyControlsDisabled() {
    const gate = !socketConnected || !receivedFirstState;
    const allowed = computeAllowed(latestView);

    els.lockJoins.disabled = gate || pending.has('lockJoins') || !allowed.lockJoins;
    // N-flicker (code review): don't resync the checkbox from the (possibly stale) last
    // snapshot while the host's own toggle is still in flight — a room:state that arrives
    // between the click and its ack used to snap the checkbox back and then forward again.
    if (latestView && !pending.has('lockJoins')) els.lockJoins.checked = Boolean(latestView.joinLocked);

    els.btnStart.disabled = gate || pending.has('start') || !allowed.start;

    els.btnCountdown.disabled = gate || pending.has('countdown') || !allowed.countdown;
    els.countdownSeconds.disabled = gate || !allowed.countdown;

    els.btnRevealNext.disabled = gate || pending.has('reveal') || !allowed.reveal;
    els.btnRevealAll.disabled = gate || pending.has('reveal') || !allowed.reveal;

    els.btnClose.disabled = gate || pending.has('close') || !allowed.close;
  }

  function renderControls() {
    applyControlsDisabled();
  }

  els.lockJoins.addEventListener('change', () => {
    const locked = els.lockJoins.checked;
    hostAction('lockJoins', { type: 'lockJoins', locked }, (err, res) => {
      // Restore the checkbox to its pre-toggle value on a timeout or a rejected action —
      // hostAction has already shown the toast; this just undoes the optimistic flip.
      if (err || (res && res.ok === false)) els.lockJoins.checked = !locked;
    });
  });

  els.btnStart.addEventListener('click', () => hostAction('start', { type: 'start' }));

  els.btnCountdown.addEventListener('click', () => {
    const seconds = Number(els.countdownSeconds.value) || fallbackCountdownSeconds;
    hostAction('countdown', { type: 'countdown', seconds });
  });

  // Both reveal buttons share the 'reveal' pending key: the browser audit's M5 finding was a
  // fast double-tap firing two `reveal` events before the first round trip completed (each one
  // independently opening "the next unrevealed box"), so a click on either one disables both.
  els.btnRevealNext.addEventListener('click', () => hostAction('reveal', { type: 'reveal', mode: 'next' }));
  els.btnRevealAll.addEventListener('click', () => hostAction('reveal', { type: 'reveal', mode: 'all' }));

  els.btnClose.addEventListener('click', async () => {
    if (pending.has('close')) return;
    const ok = await confirmDialog({ title: 'Close this room?', text: 'Everyone will be disconnected right away. This cannot be undone.', ok: 'Close room' });
    if (!ok) return;
    hostAction('close', { type: 'close' });
  });

  els.copyInvite.addEventListener('click', async () => {
    const text = `Join at ${location.origin}/join?code=${code} — code ${code}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Invite copied!');
    } catch {
      toast('Copy failed — please share the code manually.');
    }
  });

  // ---------- countdown ----------

  function tickCountdown() {
    if (!latestView || !latestView.countdownEndsAt || latestView.status !== 'picking') {
      els.countdownPill.hidden = true;
      return;
    }
    const endsAt = latestView.countdownEndsAt;
    const remaining = new Date(endsAt).getTime() - (Date.now() + skewMs);
    if (remaining <= 0) {
      els.countdownPill.hidden = true;
      // Record this endsAt as seen (silently) so a countdown that's already over by the time
      // we first observe it never announces "Countdown started." or anything else, stale.
      if (endsAt !== announcedFor) { announcedFor = endsAt; announcedMilestones = new Set([10, 5]); }
      return;
    }
    const seconds = Math.ceil(remaining / 1000);
    if (endsAt !== announcedFor) {
      announcedFor = endsAt;
      announcedMilestones = new Set();
      announce(seconds > 10 ? 'Countdown started.' : `${seconds} seconds left.`);
      // Pre-mark any milestone already behind us at first sighting so it's never re-announced
      // right after the message above (e.g. a 5s countdown shouldn't hear "started" then "5
      // seconds left" back to back — just the one, correct message).
      if (seconds <= 10) announcedMilestones.add(10);
      if (seconds <= 5) announcedMilestones.add(5);
    }
    els.countdownPill.hidden = false;
    els.countdownPill.textContent = `⏱ ${seconds}s`;
    if (seconds <= 10 && !announcedMilestones.has(10)) { announcedMilestones.add(10); announce('10 seconds left.'); }
    if (seconds <= 5 && !announcedMilestones.has(5)) { announcedMilestones.add(5); announce('5 seconds left.'); }
  }

  // ---------- setup ----------

  async function loadCountdownDefault() {
    try {
      const res = await fetch('/api/admin/rooms');
      if (res.status === 401) return goToRooms();
      if (!res.ok) return;
      const rooms = await res.json();
      const summary = rooms.find((r) => r.code === code);
      if (summary && summary.countdownSeconds) {
        fallbackCountdownSeconds = summary.countdownSeconds;
        els.countdownSeconds.value = summary.countdownSeconds;
      }
    } catch {
      /* keep the 15s default */
    }
  }

  applyControlsDisabled();
  startStars(els.stars);
  loadCountdownDefault();
  setInterval(tickCountdown, 250);
})();
