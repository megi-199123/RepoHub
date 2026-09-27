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
    statusText: $('status-text'),
    countdownPill: $('countdown-pill'),
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

  let toastTimer;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3200);
  }

  function ackHandler(res) {
    if (res && res.ok === false) toast(res.error);
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

  socket.on('connect', () => { if (!ended) joinRoom(); });
  socket.on('room:state', handleState);
  socket.on('cursor', (msg) => board.handCursor(msg));
  socket.on('cursor:hide', (msg) => board.hideCursor(msg.playerId));
  socket.on('room:closed', () => {
    ended = true;
    socket.disconnect();
    els.endedScreen.hidden = false;
  });

  function handleState(view) {
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

  function renderStatus(view) {
    els.statusText.textContent = STATUS_TEXT[view.status] || '';
  }

  function renderPlayers(view) {
    els.playerEmpty.hidden = view.players.length > 0;
    els.playerList.replaceChildren(
      ...view.players.map((p) => {
        const locked = p.lockedBox !== null && p.lockedBox !== undefined;
        const li = document.createElement('li');
        li.className = `host-player${p.connected ? ' is-connected' : ''}`;
        li.style.setProperty('--chip-color', p.color);
        li.innerHTML = `
          <span class="host-player-avatar">${esc(p.avatar)}</span>
          <span class="host-player-dot" aria-hidden="true"></span>
          <span class="host-player-name">${esc(p.name)}</span>
          ${p.role === 'spectator' ? '<span class="chip info">watching</span>' : ''}
          ${locked ? '<span class="chip ok">locked</span>' : ''}
          <button class="icon-btn danger host-kick" type="button" data-id="${esc(p.id)}" data-name="${esc(p.name)}" title="Kick ${esc(p.name)}" aria-label="Kick ${esc(p.name)}">✕</button>
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
    const ok = await confirmDialog({ title: `Remove ${btn.dataset.name}?`, text: 'They will be disconnected from this room right away.', ok: 'Kick' });
    if (!ok) return;
    socket.emit('host:action', { type: 'kick', playerId: btn.dataset.id }, ackHandler);
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

  function renderControls(view) {
    const status = view.status;
    const isFinishedOrClosed = status === 'finished' || status === 'closed';
    els.lockJoins.disabled = isFinishedOrClosed;
    els.lockJoins.checked = Boolean(view.joinLocked);

    els.btnStart.disabled = status !== 'lobby';

    const canCountdown = status === 'picking';
    els.btnCountdown.disabled = !canCountdown;
    els.countdownSeconds.disabled = !canCountdown;

    const canReveal = ['picking', 'locked', 'revealing'].includes(status);
    els.btnRevealNext.disabled = !canReveal;
    els.btnRevealAll.disabled = !canReveal;
  }

  els.lockJoins.addEventListener('change', () => {
    const locked = els.lockJoins.checked;
    socket.emit('host:action', { type: 'lockJoins', locked }, (res) => {
      if (res && res.ok === false) {
        els.lockJoins.checked = !locked;
        toast(res.error);
      }
    });
  });

  els.btnStart.addEventListener('click', () => socket.emit('host:action', { type: 'start' }, ackHandler));

  els.btnCountdown.addEventListener('click', () => {
    const seconds = Number(els.countdownSeconds.value) || fallbackCountdownSeconds;
    socket.emit('host:action', { type: 'countdown', seconds }, ackHandler);
  });

  els.btnRevealNext.addEventListener('click', () => socket.emit('host:action', { type: 'reveal', mode: 'next' }, ackHandler));
  els.btnRevealAll.addEventListener('click', () => socket.emit('host:action', { type: 'reveal', mode: 'all' }, ackHandler));

  els.btnClose.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Close this room?', text: 'Everyone will be disconnected right away. This cannot be undone.', ok: 'Close room' });
    if (!ok) return;
    socket.emit('host:action', { type: 'close' }, ackHandler);
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
    const remaining = new Date(latestView.countdownEndsAt).getTime() - (Date.now() + skewMs);
    if (remaining <= 0) {
      els.countdownPill.hidden = true;
      return;
    }
    els.countdownPill.hidden = false;
    els.countdownPill.textContent = `⏱ ${Math.ceil(remaining / 1000)}s`;
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

  startStars(els.stars);
  loadCountdownDefault();
  setInterval(tickCountdown, 250);
})();
