(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const EMOJIS = ['🎁', '📱', '💻', '🎧', '⌚', '🎮', '📷', '🎟️', '💳', '💰', '💎', '🏆', '🥇', '☕', '🍔', '🍕', '🍩', '🍫', '🧸', '🛍️', '🌟', '🍀', '🎉', '✈️'];
  const SWATCHES = ['#f59e0b', '#ef4444', '#ec4899', '#a855f7', '#8b5cf6', '#6366f1', '#3b82f6', '#06b6d4', '#10b981', '#84cc16', '#64748b'];

  const ICONS = {
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  };

  const TABS = ['rooms', 'winners', 'users'];

  // `rooms` is always fetched with ?include=closed and cached here — the "Show closed" toggle,
  // the Winners room filter and "Copy prizes from" are all client-side filters over one list
  // (see the frozen contract's admin section + the plan's note on avoiding three separate fetches).
  const state = {
    user: null,
    rooms: [],
    showClosed: false,
    currentRoomId: null,
    currentRoom: null,
    prizes: [],
    odds: {},
    roomDraws: [],
    allDraws: [],
    users: [],
  };

  // ---------- utils ----------

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    if (res.status === 401 && !path.endsWith('/login')) {
      showLogin();
      throw new Error('Your session has expired. Please sign in again.');
    }
    const data = res.status === 204 ? null : await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error || 'Something went wrong');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(message, type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = `${type === 'error' ? '⚠️' : '✅'}  ${message}`;
    $('#toasts').append(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3000);
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (n) => (n >= 0.1 ? `${(n * 100).toFixed(0)}%` : n > 0 ? `${(n * 100).toFixed(1)}%` : '0%');
  const fmt = (n) => Number(n).toLocaleString();

  function artHtml(p) {
    return p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" />` : esc(p.emoji || '🎁');
  }

  function stat(label, value) {
    return `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`;
  }

  function typeLabel(type) { return type === 'managed' ? 'Managed' : 'Default'; }

  function roomStatusChipClass(status) {
    if (status === 'lobby' || status === 'open') return 'info';
    if (status === 'finished' || status === 'closed') return 'off';
    if (status === 'locked' || status === 'revealing') return 'warn';
    return '';
  }

  // Disables the button and swaps its label for the duration of `fn()`, restoring both
  // afterwards no matter how it exits (double-submit guard used by every form here).
  function withBusy(button, busyText, fn) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    return fn().finally(() => {
      button.disabled = false;
      button.textContent = original;
    });
  }

  function confirmDialog({ title, text, ok = 'Delete' }) {
    const dlg = $('#confirm-dialog');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = ok;
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
  }

  // Every dialog's Cancel/✕ button carries [data-close] — one delegate-free wiring for all of
  // them (room, prize, password, invite, reset-password all share this).
  for (const b of $$('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());

  // ---------- auth ----------

  function resetState() {
    state.user = null;
    state.rooms = [];
    state.showClosed = false;
    state.currentRoomId = null;
    state.currentRoom = null;
    state.prizes = [];
    state.odds = {};
    state.roomDraws = [];
    state.allDraws = [];
    state.users = [];
    $('#room-list').innerHTML = '';
    $('#draw-rows').innerHTML = '';
    $('#user-rows').innerHTML = '';
    $('#show-closed').checked = false;
    try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
  }

  // A 401 from api() (session expired) and an explicit sign-out both land here — reset first so
  // the NEXT tenant to sign in on this tab never sees a flash of the previous one's rooms/draws.
  function showLogin() {
    resetState();
    $('#dash').hidden = true;
    $('#login').hidden = false;
    $('#login-password').focus();
  }

  async function showDash() {
    $('#login').hidden = true;
    $('#dash').hidden = false;
    $('#user-name').textContent = state.user.name;
    $('#user-name').title = state.user.email;
    $('#tab-users').hidden = state.user.role !== 'superadmin';
    await refreshRooms();
    route();
  }

  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#login-error');
    err.hidden = true;
    const submit = $('button[type=submit]', e.target);
    withBusy(submit, 'Signing in…', async () => {
      try {
        const { user } = await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: $('#login-email').value.trim(), password: $('#login-password').value }),
        });
        $('#login-password').value = '';
        state.user = user;
        await showDash();
      } catch (error) {
        err.textContent = error.message;
        err.hidden = false;
        $('.login-card').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }], { duration: 300 });
      }
    });
  });

  $('#logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  // ---------- change my password ----------

  const passwordDialog = $('#password-dialog');
  const passwordForm = $('#password-form');

  $('#change-password-btn').addEventListener('click', () => {
    passwordForm.reset();
    $('#password-error').hidden = true;
    passwordDialog.showModal();
    passwordForm.currentPassword.focus();
  });

  passwordForm.addEventListener('submit', (e) => {
    e.preventDefault();
    $('#password-error').hidden = true;
    const submit = $('button[type=submit]', passwordForm);
    withBusy(submit, 'Saving…', async () => {
      try {
        await api('/api/auth/password', {
          method: 'PUT',
          body: JSON.stringify({ currentPassword: passwordForm.currentPassword.value, newPassword: passwordForm.newPassword.value }),
        });
        passwordDialog.close();
        toast('Password changed');
      } catch (err) {
        $('#password-error').textContent = err.message;
        $('#password-error').hidden = false;
      }
    });
  });

  // ---------- routing (hash-driven: #rooms, #rooms/<id>, #winners, #users) ----------

  function route() {
    const hash = location.hash.slice(1) || 'rooms';
    const [name, sub] = hash.split('/');
    let tab = TABS.includes(name) ? name : 'rooms';
    if (tab === 'users' && state.user.role !== 'superadmin') tab = 'rooms';

    for (const t of $$('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === tab));
    for (const panel of $$('.panel')) panel.hidden = panel.dataset.panel !== tab;

    if (tab === 'rooms') {
      if (sub) openRoomDetail(sub);
      else showRoomsList();
    } else if (tab === 'winners') {
      loadWinnersTab();
    } else if (tab === 'users') {
      loadUsers();
    }
  }

  for (const tab of $$('.tab')) tab.addEventListener('click', () => { location.hash = tab.dataset.tab; });
  window.addEventListener('hashchange', () => { if (!$('#dash').hidden) route(); });

  // ---------- rooms: list ----------

  async function refreshRooms() {
    state.rooms = await api('/api/admin/rooms?include=closed');
    renderRoomList(); // harmless when the detail view is the one currently showing
  }

  function showRoomsList() {
    state.currentRoomId = null;
    state.currentRoom = null;
    $('#room-detail-view').hidden = true;
    $('#rooms-list-view').hidden = false;
    renderRoomList();
  }

  function renderRoomList() {
    const rooms = state.rooms.filter((r) => state.showClosed || r.status !== 'closed');
    $('#room-empty').hidden = rooms.length > 0;
    $('#room-list').innerHTML = rooms.map((r) => {
      const created = new Date(r.createdAt);
      return `
        <li class="room-row${r.status === 'closed' ? ' is-closed' : ''}" data-id="${esc(r.id)}">
          <button class="room-row-open" type="button" aria-label="Open room ${esc(r.title)}, code ${esc(r.code)}">
            <div class="room-row-main">
              <span class="chip type-${r.type}">${typeLabel(r.type)}</span>
              <span class="chip ${roomStatusChipClass(r.status)}">${esc(r.status)}</span>
              <strong class="room-row-code">${esc(r.code)}</strong>
            </div>
            <div class="room-row-title">${esc(r.title)}</div>
            <div class="room-row-meta muted">
              ${fmt(r.playerCount)} player${r.playerCount === 1 ? '' : 's'} · ${fmt(r.prizeCount)} prize${r.prizeCount === 1 ? '' : 's'} · ${fmt(r.drawCount)} draw${r.drawCount === 1 ? '' : 's'} · ${created.toLocaleDateString()}
            </div>
          </button>
        </li>`;
    }).join('');
  }

  $('#show-closed').addEventListener('change', (e) => { state.showClosed = e.target.checked; renderRoomList(); });

  $('#room-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.room-row-open');
    if (!btn) return;
    location.hash = `rooms/${btn.closest('.room-row').dataset.id}`;
  });

  // ---------- rooms: create dialog ----------

  const roomDialog = $('#room-dialog');
  const roomForm = $('#room-form');

  function updateRoomDialogFieldsForType() {
    const type = roomForm.type.value;
    $('#room-dialog-maxplays').hidden = type !== 'default';
    $('#room-dialog-countdown').hidden = type !== 'managed';
    $('#room-dialog-chat').hidden = type !== 'managed';
  }
  for (const r of roomForm.type) r.addEventListener('change', updateRoomDialogFieldsForType);

  function populateCopyFromOptions() {
    const select = roomForm.copyPrizesFrom;
    const current = select.value;
    select.innerHTML = '<option value="">— Sample prizes —</option>' + state.rooms.map((r) =>
      `<option value="${esc(r.id)}">${esc(r.title)} (${esc(r.code)}${r.status === 'closed' ? ', closed' : ''})</option>`,
    ).join('');
    select.value = current;
  }

  $('#create-room-btn').addEventListener('click', () => {
    roomForm.reset();
    updateRoomDialogFieldsForType();
    populateCopyFromOptions();
    $('#room-dialog-error').hidden = true;
    roomDialog.showModal();
    roomForm.title.focus();
  });

  roomForm.addEventListener('submit', (e) => {
    e.preventDefault();
    $('#room-dialog-error').hidden = true;
    const type = roomForm.type.value;
    const body = {
      type,
      title: roomForm.title.value.trim() || undefined,
      subtitle: roomForm.subtitle.value.trim() || undefined,
      boxCount: Number(roomForm.boxCount.value),
      style: roomForm.style.value,
      assignment: roomForm.assignment.value,
      showPrizes: roomForm.showPrizes.checked,
    };
    if (type === 'default') {
      body.maxPlaysPerVisitor = Number(roomForm.maxPlaysPerVisitor.value || 0);
    } else {
      const seconds = roomForm.countdownSeconds.value.trim();
      if (seconds !== '') body.countdownSeconds = Number(seconds);
      body.chatEnabled = roomForm.chatEnabled.checked;
    }
    if (roomForm.copyPrizesFrom.value) body.copyPrizesFrom = roomForm.copyPrizesFrom.value;

    const submit = $('button[type=submit]', roomForm);
    withBusy(submit, 'Creating…', async () => {
      try {
        const room = await api('/api/admin/rooms', { method: 'POST', body: JSON.stringify(body) });
        roomDialog.close();
        toast(`Room ${room.code} created`);
        await refreshRooms();
        location.hash = `rooms/${room.id}`;
      } catch (err) {
        $('#room-dialog-error').textContent = err.message;
        $('#room-dialog-error').hidden = false;
      }
    });
  });

  // ---------- room detail ----------

  async function openRoomDetail(id) {
    state.currentRoomId = id;
    $('#rooms-list-view').hidden = true;
    $('#room-detail-view').hidden = false;
    try {
      const room = await api(`/api/admin/rooms/${id}`);
      state.currentRoom = room;
      renderRoomDetailShell(room);
      await Promise.all([loadRoomPrizes(id), loadRoomDraws(id)]);
    } catch (err) {
      toast(err.message, 'error');
      location.hash = 'rooms';
    }
  }

  $('#room-detail-back').addEventListener('click', () => { location.hash = 'rooms'; });

  function renderRoomDetailShell(room) {
    const closed = room.status === 'closed';
    // Addendum A1: box count can still change while `picking` (re-deals + frees locks past the
    // new count) — style/countdown/assignment stay locked past `lobby` as before.
    const structuralLocked = !closed && room.type === 'managed' && room.status !== 'lobby';
    const boxCountLocked = !closed && room.type === 'managed' && !['lobby', 'picking'].includes(room.status);

    document.title = `${room.title} · Backoffice`;
    $('#rd-title-heading').textContent = room.title;
    $('#rd-type-badge').textContent = typeLabel(room.type);
    $('#rd-type-badge').className = `chip type-${room.type}`;
    $('#rd-status-badge').textContent = room.status;
    $('#rd-status-badge').className = `chip ${roomStatusChipClass(room.status)}`;
    $('#rd-code').textContent = room.code;

    $('#rd-closed-banner').hidden = !closed;
    $('#rd-locked-note').hidden = closed || !structuralLocked;
    $('#rd-locked-note').textContent = boxCountLocked
      ? 'This room has already started — only the title, subtitle and prize lineup can change now.'
      : 'This room has already started — style, countdown and assignment are locked, but the number of boxes, title, subtitle and prize lineup can still change while players are picking.';

    $('#rd-host-console').hidden = room.type !== 'managed';
    if (room.type === 'managed') $('#rd-host-console').href = `/admin/room?code=${encodeURIComponent(room.code)}`;

    // Addendum A2: managed rooms get a separate player link and watch link; default rooms keep
    // the single play link.
    $('#rd-links-row').hidden = room.type !== 'managed';
    if (room.type === 'managed') {
      const playerUrl = `${location.origin}/?code=${room.code}`;
      const watchUrl = `${location.origin}/watch?code=${room.code}`;
      $('#rd-player-link').textContent = playerUrl;
      $('#rd-player-open').href = playerUrl;
      $('#rd-watch-link').textContent = watchUrl;
      $('#rd-watch-open').href = watchUrl;
    }

    $('#rd-play-link-row').hidden = room.type !== 'default';
    if (room.type === 'default') {
      const url = `${location.origin}/play?code=${room.code}`;
      $('#rd-play-link').textContent = url;
      $('#rd-play-open').href = url;
    }

    $('#rd-close-room').hidden = closed;

    const f = $('#room-settings-form');
    f.title.value = room.title;
    f.subtitle.value = room.subtitle || '';
    f.boxCount.value = room.boxCount;
    $('#rd-box-count-out').textContent = room.boxCount;
    f.style.value = room.style || 'gift';
    for (const r of f.assignment) r.checked = r.value === room.assignment;
    f.showPrizes.checked = room.showPrizes;

    $('#rd-maxplays-field').hidden = room.type !== 'default';
    $('#rd-countdown-field').hidden = room.type !== 'managed';
    $('#rd-chat-field').hidden = room.type !== 'managed';
    if (room.type === 'default') f.maxPlaysPerVisitor.value = room.maxPlaysPerVisitor ?? 0;
    if (room.type === 'managed') {
      f.countdownSeconds.value = room.countdownSeconds ?? '';
      // Addendum B2: chatEnabled has no lobby-only restriction (any non-closed status), so it's
      // never part of `structuralLocked` below — only the closed-room fieldset disable applies.
      f.chatEnabled.checked = Boolean(room.chatEnabled);
    }

    // Closed rooms are fully read-only; a managed room that has already left the lobby can
    // still change title/subtitle/showPrizes (and box count, while picking) — grey out just the
    // specific fields that would 409 rather than the whole form.
    $('#room-settings-fieldset').disabled = closed;
    f.boxCount.disabled = boxCountLocked;
    f.style.disabled = structuralLocked;
    for (const r of f.assignment) r.disabled = structuralLocked;
    if (room.type === 'managed') f.countdownSeconds.disabled = structuralLocked;

    $('#rd-add-prize').disabled = closed;
  }

  $('#room-settings-form').boxCount.addEventListener('input', (e) => { $('#rd-box-count-out').textContent = e.target.value; });

  $('#room-settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#room-settings-error').hidden = true;
    const room = state.currentRoom;
    if (!room || room.status === 'closed') return;
    const f = e.target;
    const structuralLocked = room.type === 'managed' && room.status !== 'lobby';
    const boxCountLocked = room.type === 'managed' && !['lobby', 'picking'].includes(room.status);
    const body = {
      title: f.title.value,
      subtitle: f.subtitle.value,
      showPrizes: f.showPrizes.checked,
    };
    if (!boxCountLocked) body.boxCount = Number(f.boxCount.value);
    if (!structuralLocked) {
      body.style = f.style.value;
      body.assignment = f.assignment.value;
      if (room.type === 'managed') {
        const seconds = f.countdownSeconds.value.trim();
        if (seconds !== '') body.countdownSeconds = Number(seconds);
      }
    }
    if (room.type === 'default') body.maxPlaysPerVisitor = Number(f.maxPlaysPerVisitor.value || 0);
    if (room.type === 'managed') body.chatEnabled = f.chatEnabled.checked;

    const submit = $('button[type=submit]', f);
    withBusy(submit, 'Saving…', async () => {
      try {
        const updated = await api(`/api/admin/rooms/${room.id}`, { method: 'PUT', body: JSON.stringify(body) });
        state.currentRoom = updated;
        renderRoomDetailShell(updated);
        const idx = state.rooms.findIndex((r) => r.id === updated.id);
        if (idx !== -1) state.rooms[idx] = updated;
        renderRoomList();
        toast('Settings saved');
      } catch (err) {
        $('#room-settings-error').textContent = err.message;
        $('#room-settings-error').hidden = false;
      }
    });
  });

  $('#rd-close-room').addEventListener('click', async () => {
    const room = state.currentRoom;
    if (!room) return;
    const ok = await confirmDialog({ title: `Close room ${room.code}?`, text: 'Everyone in this room will be disconnected right away. This cannot be undone.', ok: 'Close room' });
    if (!ok) return;
    try {
      await api(`/api/admin/rooms/${room.id}`, { method: 'DELETE' });
      toast(`Room ${room.code} closed`);
      await refreshRooms();
      const updated = await api(`/api/admin/rooms/${room.id}`);
      state.currentRoom = updated;
      renderRoomDetailShell(updated);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#rd-player-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#rd-player-link').textContent);
      toast('Player link copied!');
    } catch {
      toast('Copy failed — please share the link manually.', 'error');
    }
  });
  $('#rd-watch-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#rd-watch-link').textContent);
      toast('Watch link copied!');
    } catch {
      toast('Copy failed — please share the link manually.', 'error');
    }
  });
  $('#rd-play-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#rd-play-link').textContent);
      toast('Play link copied!');
    } catch {
      toast('Copy failed — please share the link manually.', 'error');
    }
  });

  // ---------- room detail: prizes ----------

  async function loadRoomPrizes(roomId) {
    const [prizes, odds] = await Promise.all([
      api(`/api/admin/rooms/${roomId}/prizes`),
      api(`/api/admin/rooms/${roomId}/odds`),
    ]);
    state.prizes = prizes;
    state.odds = odds;
    renderRoomPrizes();
  }

  function renderRoomPrizes() {
    const { prizes, odds } = state;
    const room = state.currentRoom;
    const readOnly = !room || room.status === 'closed';
    const available = prizes.filter((p) => p.available);
    const limited = prizes.filter((p) => p.stock !== null);
    const won = prizes.reduce((sum, p) => sum + p.won, 0);

    $('#rd-prize-stats').innerHTML = [
      stat('🎁 Prizes in play', `${available.length}<small class="muted"> / ${prizes.length}</small>`),
      stat('📦 Stock left', limited.length === prizes.length ? fmt(limited.reduce((s, p) => s + p.stock, 0)) : '∞'),
      stat('🏆 Times won', fmt(won)),
    ].join('');

    const note = $('#rd-odds-note');
    if (prizes.length && !available.length) {
      note.textContent = 'No prize is currently available (all inactive, zero weight or out of stock) — players will see “All prizes have been claimed”.';
      note.hidden = false;
    } else if (room && room.assignment === 'unique' && available.length > 1 && available.length <= room.boxCount) {
      note.textContent = `💡 With ${available.length} prizes and ${room.boxCount} boxes in “Different prize in every box” mode, every prize is in every round, so weights have no effect. Switch to “Pure odds” in Settings to make rare prizes rarer.`;
      note.hidden = false;
    } else {
      note.hidden = true;
    }

    $('#rd-prize-empty').hidden = prizes.length > 0;
    $('#rd-prize-list').innerHTML = prizes.map((p, i) => {
      const chips = [];
      if (!p.active) chips.push('<span class="chip off">Inactive</span>');
      else if (p.stock === 0) chips.push('<span class="chip warn">Out of stock</span>');
      else if (p.weight === 0) chips.push('<span class="chip warn">Weight 0</span>');
      if (!p.winning) chips.push('<span class="chip info">No-win</span>');
      const chance = odds[p.id] || 0;
      return `
        <li class="prize ${p.available ? '' : 'is-off'}" style="--c:${esc(p.color)};--i:${i}" data-id="${esc(p.id)}">
          <div class="prize-art${p.image && p.imageBorder === false ? ' no-border' : ''}">${artHtml(p)}</div>
          <div class="prize-main">
            <div class="prize-title"><strong>${esc(p.name)}</strong>${chips.join('')}</div>
            <p class="prize-desc"${p.description ? ` title="${esc(p.description)}"` : ''}>${esc(p.description) || '<span class="muted">No description</span>'}</p>
            <div class="metrics">
              <div class="metric"><span class="metric-label">Weight</span><span class="metric-value">${fmt(p.weight)}</span></div>
              <div class="metric"><span class="metric-label">Stock</span><span class="metric-value">${p.stock === null ? '∞' : fmt(p.stock)}</span></div>
              <div class="metric"><span class="metric-label">Won</span><span class="metric-value">${fmt(p.won)}</span></div>
              <div class="metric odds">
                <span class="metric-label">Win chance · ${pct(chance)}</span>
                <div class="odds-bar"><span data-w="${(chance * 100).toFixed(2)}"></span></div>
              </div>
            </div>
          </div>
          <div class="prize-actions">
            <input type="checkbox" class="switch" data-act="toggle" ${p.active ? 'checked' : ''} ${readOnly ? 'disabled' : ''} aria-label="Active" title="Active" />
            <button class="icon-btn" data-act="up" title="Move up" aria-label="Move up" ${readOnly || i === 0 ? 'disabled' : ''}>${ICONS.up}</button>
            <button class="icon-btn" data-act="down" title="Move down" aria-label="Move down" ${readOnly || i === prizes.length - 1 ? 'disabled' : ''}>${ICONS.down}</button>
            <button class="icon-btn" data-act="edit" title="Edit" aria-label="Edit" ${readOnly ? 'disabled' : ''}>${ICONS.edit}</button>
            <button class="icon-btn danger" data-act="delete" title="Delete" aria-label="Delete" ${readOnly ? 'disabled' : ''}>${ICONS.trash}</button>
          </div>
        </li>`;
    }).join('');

    requestAnimationFrame(() => {
      for (const bar of $$('#rd-prize-list .odds-bar span')) bar.style.width = `${bar.dataset.w}%`;
    });
  }

  $('#rd-prize-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.dataset.act === 'toggle') return;
    const id = btn.closest('.prize').dataset.id;
    const prize = state.prizes.find((p) => p.id === id);
    const roomId = state.currentRoomId;
    const act = btn.dataset.act;

    try {
      if (act === 'edit') openEditor(prize);
      if (act === 'delete') {
        const ok = await confirmDialog({ title: `Delete “${prize.name}”?`, text: 'This removes the prize. Past winners stay in the log.' });
        if (!ok) return;
        await api(`/api/admin/rooms/${roomId}/prizes/${id}`, { method: 'DELETE' });
        toast('Prize deleted');
        await loadRoomPrizes(roomId);
      }
      if (act === 'up' || act === 'down') {
        const ids = state.prizes.map((p) => p.id);
        const i = ids.indexOf(id);
        const j = act === 'up' ? i - 1 : i + 1;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        await api(`/api/admin/rooms/${roomId}/prizes-order`, { method: 'PUT', body: JSON.stringify({ ids }) });
        await loadRoomPrizes(roomId);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#rd-prize-list').addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'toggle') return;
    const id = e.target.closest('.prize').dataset.id;
    const roomId = state.currentRoomId;
    try {
      await api(`/api/admin/rooms/${roomId}/prizes/${id}`, { method: 'PUT', body: JSON.stringify({ active: e.target.checked }) });
      toast(e.target.checked ? 'Prize activated' : 'Prize deactivated');
      await loadRoomPrizes(roomId);
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message, 'error');
    }
  });

  // ---------- prize editor dialog (shared: Add + Edit) ----------

  const prizeDialog = $('#prize-dialog');
  const prizeForm = $('#prize-form');
  let editingPrize = null;

  $('#emoji-grid').innerHTML = EMOJIS.map((e) => `<button type="button" data-emoji="${e}" aria-label="${e}">${e}</button>`).join('');
  $('#swatches').innerHTML = SWATCHES.map((c) => `<button type="button" data-color="${c}" style="--s:${c}" aria-label="Color ${c}"></button>`).join('');

  function openEditor(prize = null) {
    editingPrize = prize;
    $('#prize-dialog-title').textContent = prize ? 'Edit prize' : 'Add prize';
    const p = prize || { name: '', description: '', emoji: '🎁', image: '', color: '#8b5cf6', weight: 1, stock: null, active: true, winning: true, imageBorder: true };
    prizeForm.name.value = p.name;
    prizeForm.description.value = p.description;
    prizeForm.emoji.value = p.emoji;
    prizeForm.image.value = p.image || '';
    prizeForm.color.value = p.color;
    prizeForm.weight.value = p.weight;
    prizeForm.unlimited.checked = p.stock === null;
    prizeForm.stock.value = p.stock ?? '';
    prizeForm.stock.disabled = p.stock === null;
    prizeForm.active.checked = p.active;
    prizeForm.winning.checked = p.winning !== false;
    prizeForm.imageBorder.checked = p.imageBorder !== false;
    $('#prize-error').hidden = true;
    updatePreview();
    prizeDialog.showModal();
    prizeForm.name.focus();
  }

  $('#rd-add-prize').addEventListener('click', () => openEditor());

  function updatePreview() {
    const card = $('#preview-card');
    card.style.setProperty('--c', prizeForm.color.value);
    const art = $('#preview-art');
    const image = prizeForm.image.value.trim();
    if (image) art.innerHTML = `<img src="${esc(image)}" alt="" />`;
    else art.textContent = prizeForm.emoji.value || '🎁';
    // B1: the border toggle is only meaningful once there's an image to show.
    prizeForm.imageBorder.disabled = !image;
    art.classList.toggle('no-border', Boolean(image) && !prizeForm.imageBorder.checked);
    $('#preview-name').textContent = prizeForm.name.value || 'Prize name';
    $('#preview-desc').textContent = prizeForm.description.value;
    $('#preview-kicker').textContent = prizeForm.winning.checked ? '🎉 You won 🎉' : 'So close!';
    for (const b of $$('#emoji-grid button')) b.setAttribute('aria-pressed', String(b.dataset.emoji === prizeForm.emoji.value));
    for (const b of $$('#swatches button')) b.setAttribute('aria-pressed', String(b.dataset.color === prizeForm.color.value.toLowerCase()));
  }

  prizeForm.addEventListener('input', updatePreview);
  prizeForm.unlimited.addEventListener('change', () => {
    prizeForm.stock.disabled = prizeForm.unlimited.checked;
    if (!prizeForm.unlimited.checked && prizeForm.stock.value === '') prizeForm.stock.value = 10;
    if (!prizeForm.unlimited.checked) prizeForm.stock.focus();
  });
  $('#emoji-grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-emoji]');
    if (!b) return;
    prizeForm.emoji.value = b.dataset.emoji;
    updatePreview();
  });
  $('#swatches').addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    prizeForm.color.value = b.dataset.color;
    updatePreview();
  });
  $('#image-clear').addEventListener('click', () => { prizeForm.image.value = ''; $('#image-file').value = ''; updatePreview(); });

  $('#image-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('Image must be 2 MB or smaller', 'error'); return; }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    try {
      const { url } = await api('/api/admin/uploads', { method: 'POST', body: JSON.stringify({ dataUrl }) });
      prizeForm.image.value = url;
      updatePreview();
      toast('Image uploaded');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  prizeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const roomId = state.currentRoomId;
    const body = {
      name: prizeForm.name.value,
      description: prizeForm.description.value,
      emoji: prizeForm.emoji.value,
      image: prizeForm.image.value.trim() || null,
      color: prizeForm.color.value,
      weight: Number(prizeForm.weight.value),
      stock: prizeForm.unlimited.checked ? null : Number(prizeForm.stock.value),
      active: prizeForm.active.checked,
      winning: prizeForm.winning.checked,
      imageBorder: prizeForm.imageBorder.checked,
    };
    $('#prize-error').hidden = true;
    const submit = $('button[type=submit]', prizeForm);
    withBusy(submit, 'Saving…', async () => {
      try {
        if (editingPrize) await api(`/api/admin/rooms/${roomId}/prizes/${editingPrize.id}`, { method: 'PUT', body: JSON.stringify(body) });
        else await api(`/api/admin/rooms/${roomId}/prizes`, { method: 'POST', body: JSON.stringify(body) });
        prizeDialog.close();
        toast(editingPrize ? 'Prize updated' : 'Prize added');
        await loadRoomPrizes(roomId);
      } catch (err) {
        $('#prize-error').textContent = err.message;
        $('#prize-error').hidden = false;
      }
    });
  });

  // ---------- room detail: winners ----------

  async function loadRoomDraws(roomId) {
    state.roomDraws = await api(`/api/admin/draws?roomId=${encodeURIComponent(roomId)}`);
    renderRoomDraws();
  }

  function drawRowHtml(d, withRoomCell) {
    const date = new Date(d.createdAt);
    const playerCell = d.playerName ? esc(d.playerName) : '<span class="muted">—</span>';
    const roomCell = withRoomCell
      ? `<td data-label="Room"><span class="chip type-${d.roomType}">${typeLabel(d.roomType)}</span> <span class="code">${esc(d.roomCode)}</span><br /><span class="muted">${esc(d.roomTitle)}</span></td>`
      : '';
    return `
      <tr data-id="${esc(d.id)}">
        <td class="when" data-label="When">${date.toLocaleDateString()}<small>${date.toLocaleTimeString()}</small></td>
        ${roomCell}
        <td data-label="Player">${playerCell}</td>
        <td data-label="Prize"><span class="cell-prize"><span class="cell-emoji">${esc(d.emoji)}</span>${esc(d.prizeName)}</span></td>
        <td data-label="Claim code">${d.code ? `<span class="code">${esc(d.code)}</span>` : '<span class="muted">— no win —</span>'}</td>
        <td class="right" data-label="Redeemed">${d.code ? `<input type="checkbox" class="switch" ${d.redeemed ? 'checked' : ''} aria-label="Redeemed" />` : ''}</td>
      </tr>`;
  }

  function renderRoomDraws() {
    const draws = state.roomDraws;
    $('#rd-draw-empty').hidden = draws.length > 0;
    $('#rd-draw-rows').innerHTML = draws.map((d) => drawRowHtml(d, false)).join('');
  }

  $('#rd-draw-rows').addEventListener('change', async (e) => {
    if (!e.target.matches('.switch')) return;
    const id = e.target.closest('tr').dataset.id;
    try {
      const updated = await api(`/api/admin/draws/${id}`, { method: 'PATCH', body: JSON.stringify({ redeemed: e.target.checked }) });
      Object.assign(state.roomDraws.find((d) => d.id === id), updated);
      renderRoomDraws();
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message, 'error');
    }
  });

  // ---------- winners tab (all my rooms) ----------

  function populateRoomFilterOptions() {
    const select = $('#draw-room-filter');
    const current = select.value;
    select.innerHTML = '<option value="">All rooms</option>' + state.rooms.map((r) =>
      `<option value="${esc(r.id)}">${esc(r.code)} · ${esc(r.title)}${r.status === 'closed' ? ' (closed)' : ''}</option>`,
    ).join('');
    select.value = current;
  }

  async function loadWinnersTab() {
    populateRoomFilterOptions();
    state.allDraws = await api('/api/admin/draws');
    renderWinnersTab();
  }

  function renderWinnersTab() {
    const roomId = $('#draw-room-filter').value;
    const draws = roomId ? state.allDraws.filter((d) => d.roomId === roomId) : state.allDraws;
    const wins = draws.filter((d) => d.code);
    const redeemed = wins.filter((d) => d.redeemed);
    $('#winners-count').textContent = wins.length;
    $('#draw-stats').innerHTML = [
      stat('🎲 Boxes opened', fmt(draws.length)),
      stat('🏆 Wins', fmt(wins.length)),
      stat('✅ Redeemed', fmt(redeemed.length)),
      stat('⏳ To redeem', fmt(wins.length - redeemed.length)),
    ].join('');

    const q = $('#draw-search').value.trim().toLowerCase();
    const filter = $('#draw-filter').value;
    const rows = draws.filter((d) => {
      if (filter === 'pending' && (!d.code || d.redeemed)) return false;
      if (filter === 'redeemed' && !d.redeemed) return false;
      if (filter === 'nowin' && d.code) return false;
      return !q
        || (d.code || '').toLowerCase().includes(q)
        || d.prizeName.toLowerCase().includes(q)
        || (d.playerName || '').toLowerCase().includes(q)
        || (d.roomTitle || '').toLowerCase().includes(q)
        || (d.roomCode || '').toLowerCase().includes(q);
    });

    $('#draw-empty').hidden = rows.length > 0;
    $('#draw-empty p').textContent = draws.length ? 'Nothing matches your search.' : 'No plays yet.';
    $('#draw-rows').innerHTML = rows.map((d) => drawRowHtml(d, true)).join('');

    $('#draws-csv-link').href = roomId ? `/api/admin/draws.csv?roomId=${encodeURIComponent(roomId)}` : '/api/admin/draws.csv';
  }

  $('#draw-room-filter').addEventListener('change', renderWinnersTab);
  $('#draw-search').addEventListener('input', renderWinnersTab);
  $('#draw-filter').addEventListener('change', renderWinnersTab);

  $('#draw-rows').addEventListener('change', async (e) => {
    if (!e.target.matches('.switch')) return;
    const id = e.target.closest('tr').dataset.id;
    try {
      const updated = await api(`/api/admin/draws/${id}`, { method: 'PATCH', body: JSON.stringify({ redeemed: e.target.checked }) });
      Object.assign(state.allDraws.find((d) => d.id === id), updated);
      renderWinnersTab();
      toast(updated.redeemed ? `${updated.code} marked as redeemed` : `${updated.code} marked as not redeemed`);
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message, 'error');
    }
  });

  $('#clear-draws').addEventListener('click', async () => {
    const roomId = $('#draw-room-filter').value;
    const room = roomId ? state.rooms.find((r) => r.id === roomId) : null;
    const ok = await confirmDialog({
      title: room ? `Clear winners for room ${room.code}?` : 'Clear all your winners?',
      text: 'All matching plays and claim codes will be permanently removed. Prize stock is not restored.',
      ok: 'Clear log',
    });
    if (!ok) return;
    try {
      await api(roomId ? `/api/admin/draws?roomId=${encodeURIComponent(roomId)}` : '/api/admin/draws', { method: 'DELETE' });
      toast('Winners log cleared');
      await loadWinnersTab();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // ---------- users tab (superadmin only) ----------

  async function loadUsers() {
    if (state.user.role !== 'superadmin') return;
    state.users = await api('/api/admin/users');
    renderUsers();
  }

  function renderUsers() {
    $('#user-empty').hidden = state.users.length > 0;
    $('#user-rows').innerHTML = state.users.map((u) => `
      <tr data-id="${esc(u.id)}">
        <td data-label="Email">${esc(u.email)}</td>
        <td data-label="Name">${esc(u.name)}</td>
        <td data-label="Role">${u.role === 'superadmin' ? '<span class="chip warn">Super-admin</span>' : '<span class="chip info">Tenant</span>'}</td>
        <td data-label="Rooms">${fmt(u.roomCount)}</td>
        <td data-label="Status">${u.disabled ? '<span class="chip off">Disabled</span>' : '<span class="chip ok">Active</span>'}</td>
        <td class="right" data-label="Actions">
          <button class="btn btn-ghost" data-act="reset" type="button">Reset password</button>
          <button class="btn ${u.disabled ? 'btn-ghost' : 'btn-danger-ghost'}" data-act="toggle" type="button">${u.disabled ? 'Enable' : 'Disable'}</button>
        </td>
      </tr>`).join('');
  }

  $('#user-rows').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const user = state.users.find((u) => u.id === id);
    if (!user) return;

    if (btn.dataset.act === 'reset') {
      const dlg = $('#reset-password-dialog');
      $('#reset-password-for').textContent = `For ${user.name} (${user.email})`;
      $('#reset-password-form').reset();
      $('#reset-password-error').hidden = true;
      dlg.dataset.userId = id;
      dlg.showModal();
      $('#reset-password-form').password.focus();
      return;
    }

    if (btn.dataset.act === 'toggle') {
      const next = !user.disabled;
      if (next) {
        const ok = await confirmDialog({ title: `Disable ${user.name}?`, text: 'They will be signed out and unable to sign in until re-enabled.', ok: 'Disable' });
        if (!ok) return;
      }
      try {
        const updated = await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ disabled: next }) });
        Object.assign(user, updated);
        renderUsers();
        toast(next ? `${user.name} disabled` : `${user.name} enabled`);
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  $('#invite-user-btn').addEventListener('click', () => {
    $('#invite-form').reset();
    $('#invite-error').hidden = true;
    $('#invite-dialog').showModal();
    $('#invite-form').email.focus();
  });

  $('#invite-form').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#invite-error').hidden = true;
    const f = e.target;
    const submit = $('button[type=submit]', f);
    withBusy(submit, 'Inviting…', async () => {
      try {
        await api('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify({ email: f.email.value.trim(), name: f.name.value.trim(), password: f.password.value, role: f.role.value }),
        });
        $('#invite-dialog').close();
        toast('Account created — share the email and temporary password with them');
        await loadUsers();
      } catch (err) {
        $('#invite-error').textContent = err.message;
        $('#invite-error').hidden = false;
      }
    });
  });

  $('#reset-password-form').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#reset-password-error').hidden = true;
    const dlg = $('#reset-password-dialog');
    const id = dlg.dataset.userId;
    const submit = $('button[type=submit]', e.target);
    withBusy(submit, 'Saving…', async () => {
      try {
        await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ password: e.target.password.value }) });
        dlg.close();
        toast('Password reset');
      } catch (err) {
        $('#reset-password-error').textContent = err.message;
        $('#reset-password-error').hidden = false;
      }
    });
  });

  // ---------- boot ----------

  (async () => {
    const { authenticated, user } = await api('/api/auth/me');
    if (!authenticated) return showLogin();
    state.user = user;
    await showDash();
  })().catch((err) => toast(err.message, 'error'));
})();
