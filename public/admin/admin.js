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

  const state = { prizes: [], odds: {}, settings: null, draws: [], editing: null, rooms: [] };

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
    if (!res.ok) throw new Error(data?.error || 'Something went wrong');
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

  function confirmDialog({ title, text, ok = 'Delete' }) {
    const dlg = $('#confirm-dialog');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = ok;
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
  }

  // ---------- auth ----------

  function showLogin() {
    $('#dash').hidden = true;
    $('#login').hidden = false;
    $('#login-password').focus();
  }

  async function showDash() {
    $('#login').hidden = true;
    $('#dash').hidden = false;
    await Promise.all([loadPrizes(), loadSettings(), loadDraws()]);
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    err.hidden = true;
    try {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('#login-password').value }) });
      $('#login-password').value = '';
      await showDash();
    } catch (error) {
      err.textContent = error.message;
      err.hidden = false;
      $('.login-card').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }], { duration: 300 });
    }
  });

  $('#logout').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  // ---------- tabs ----------

  function selectTab(name) {
    for (const tab of $$('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    for (const panel of $$('.panel')) panel.hidden = panel.dataset.panel !== name;
    if (name === 'winners') loadDraws();
    if (name === 'prizes') loadPrizes();
    if (name === 'rooms') loadRooms();
    try { history.replaceState(null, '', `#${name}`); } catch { /* ignore */ }
  }
  for (const tab of $$('.tab')) tab.addEventListener('click', () => selectTab(tab.dataset.tab));

  // ---------- prizes ----------

  async function loadPrizes() {
    const [prizes, odds] = await Promise.all([api('/api/admin/prizes'), api('/api/admin/odds')]);
    state.prizes = prizes;
    state.odds = odds;
    renderPrizes();
  }

  function renderPrizes() {
    const { prizes, odds } = state;
    const available = prizes.filter((p) => p.available);
    const limited = prizes.filter((p) => p.stock !== null);
    const won = prizes.reduce((sum, p) => sum + p.won, 0);

    $('#prize-stats').innerHTML = [
      stat('🎁 Prizes in play', `${available.length}<small class="muted"> / ${prizes.length}</small>`),
      stat('📦 Stock left', limited.length === prizes.length ? fmt(limited.reduce((s, p) => s + p.stock, 0)) : '∞'),
      stat('🏆 Times won', fmt(won)),
    ].join('');

    const note = $('#odds-note');
    const s = state.settings;
    if (prizes.length && !available.length) {
      note.textContent = 'No prize is currently available (all inactive, zero weight or out of stock) — players will see “All prizes have been claimed”.';
      note.hidden = false;
    } else if (s && s.assignment === 'unique' && available.length > 1 && available.length <= s.boxCount) {
      note.textContent = `💡 With ${available.length} prizes and ${s.boxCount} boxes in “Different prize in every box” mode, every prize is in every round, so weights have no effect. Switch to “Pure odds” in Settings to make rare prizes rarer.`;
      note.hidden = false;
    } else {
      note.hidden = true;
    }

    $('#prize-empty').hidden = prizes.length > 0;
    $('#prize-list').innerHTML = prizes.map((p, i) => {
      const chips = [];
      if (!p.active) chips.push('<span class="chip off">Inactive</span>');
      else if (p.stock === 0) chips.push('<span class="chip warn">Out of stock</span>');
      else if (p.weight === 0) chips.push('<span class="chip warn">Weight 0</span>');
      if (!p.winning) chips.push('<span class="chip info">No-win</span>');
      const chance = odds[p.id] || 0;
      return `
        <li class="prize ${p.available ? '' : 'is-off'}" style="--c:${esc(p.color)};--i:${i}" data-id="${esc(p.id)}">
          <div class="prize-art">${artHtml(p)}</div>
          <div class="prize-main">
            <div class="prize-title"><strong>${esc(p.name)}</strong>${chips.join('')}</div>
            <p class="prize-desc">${esc(p.description) || '<span class="muted">No description</span>'}</p>
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
            <input type="checkbox" class="switch" data-act="toggle" ${p.active ? 'checked' : ''} aria-label="Active" title="Active" />
            <button class="icon-btn" data-act="up" title="Move up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${ICONS.up}</button>
            <button class="icon-btn" data-act="down" title="Move down" aria-label="Move down" ${i === prizes.length - 1 ? 'disabled' : ''}>${ICONS.down}</button>
            <button class="icon-btn" data-act="edit" title="Edit" aria-label="Edit">${ICONS.edit}</button>
            <button class="icon-btn danger" data-act="delete" title="Delete" aria-label="Delete">${ICONS.trash}</button>
          </div>
        </li>`;
    }).join('');

    // Animate odds bars in.
    requestAnimationFrame(() => {
      for (const bar of $$('.odds-bar span')) bar.style.width = `${bar.dataset.w}%`;
    });
  }

  $('#prize-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.dataset.act === 'toggle') return;
    const id = btn.closest('.prize').dataset.id;
    const prize = state.prizes.find((p) => p.id === id);
    const act = btn.dataset.act;

    try {
      if (act === 'edit') openEditor(prize);
      if (act === 'delete') {
        const ok = await confirmDialog({ title: `Delete “${prize.name}”?`, text: 'This removes the prize. Past winners stay in the log.' });
        if (!ok) return;
        await api(`/api/admin/prizes/${id}`, { method: 'DELETE' });
        toast('Prize deleted');
        await loadPrizes();
      }
      if (act === 'up' || act === 'down') {
        const ids = state.prizes.map((p) => p.id);
        const i = ids.indexOf(id);
        const j = act === 'up' ? i - 1 : i + 1;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        await api('/api/admin/prizes-order', { method: 'PUT', body: JSON.stringify({ ids }) });
        await loadPrizes();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#prize-list').addEventListener('change', async (e) => {
    if (e.target.dataset.act !== 'toggle') return;
    const id = e.target.closest('.prize').dataset.id;
    try {
      await api(`/api/admin/prizes/${id}`, { method: 'PUT', body: JSON.stringify({ active: e.target.checked }) });
      toast(e.target.checked ? 'Prize activated' : 'Prize deactivated');
      await loadPrizes();
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message, 'error');
    }
  });

  // ---------- prize editor ----------

  const dialog = $('#prize-dialog');
  const form = $('#prize-form');

  $('#emoji-grid').innerHTML = EMOJIS.map((e) => `<button type="button" data-emoji="${e}" aria-label="${e}">${e}</button>`).join('');
  $('#swatches').innerHTML = SWATCHES.map((c) => `<button type="button" data-color="${c}" style="--s:${c}" aria-label="Color ${c}"></button>`).join('');

  function openEditor(prize = null) {
    state.editing = prize;
    $('#prize-dialog-title').textContent = prize ? 'Edit prize' : 'Add prize';
    const p = prize || { name: '', description: '', emoji: '🎁', image: '', color: '#8b5cf6', weight: 1, stock: null, active: true, winning: true };
    form.name.value = p.name;
    form.description.value = p.description;
    form.emoji.value = p.emoji;
    form.image.value = p.image || '';
    form.color.value = p.color;
    form.weight.value = p.weight;
    form.unlimited.checked = p.stock === null;
    form.stock.value = p.stock ?? '';
    form.stock.disabled = p.stock === null;
    form.active.checked = p.active;
    form.winning.checked = p.winning !== false;
    $('#prize-error').hidden = true;
    updatePreview();
    dialog.showModal();
    form.name.focus();
  }

  function updatePreview() {
    const card = $('#preview-card');
    card.style.setProperty('--c', form.color.value);
    const art = $('#preview-art');
    const image = form.image.value.trim();
    if (image) art.innerHTML = `<img src="${esc(image)}" alt="" />`;
    else art.textContent = form.emoji.value || '🎁';
    $('#preview-name').textContent = form.name.value || 'Prize name';
    $('#preview-desc').textContent = form.description.value;
    $('#preview-kicker').textContent = form.winning.checked ? '🎉 You won 🎉' : 'So close!';
    for (const b of $$('#emoji-grid button')) b.setAttribute('aria-pressed', String(b.dataset.emoji === form.emoji.value));
    for (const b of $$('#swatches button')) b.setAttribute('aria-pressed', String(b.dataset.color === form.color.value.toLowerCase()));
  }

  form.addEventListener('input', updatePreview);
  form.unlimited.addEventListener('change', () => {
    form.stock.disabled = form.unlimited.checked;
    if (!form.unlimited.checked && form.stock.value === '') form.stock.value = 10;
    if (!form.unlimited.checked) form.stock.focus();
  });
  $('#emoji-grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-emoji]');
    if (!b) return;
    form.emoji.value = b.dataset.emoji;
    updatePreview();
  });
  $('#swatches').addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    form.color.value = b.dataset.color;
    updatePreview();
  });
  $('#image-clear').addEventListener('click', () => { form.image.value = ''; $('#image-file').value = ''; updatePreview(); });

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
      form.image.value = url;
      updatePreview();
      toast('Image uploaded');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  for (const b of $$('[data-close]', dialog)) b.addEventListener('click', () => dialog.close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: form.name.value,
      description: form.description.value,
      emoji: form.emoji.value,
      image: form.image.value.trim() || null,
      color: form.color.value,
      weight: Number(form.weight.value),
      stock: form.unlimited.checked ? null : Number(form.stock.value),
      active: form.active.checked,
      winning: form.winning.checked,
    };
    const submit = $('button[type=submit]', form);
    submit.disabled = true;
    try {
      if (state.editing) await api(`/api/admin/prizes/${state.editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/admin/prizes', { method: 'POST', body: JSON.stringify(body) });
      dialog.close();
      toast(state.editing ? 'Prize updated' : 'Prize added');
      await loadPrizes();
    } catch (err) {
      $('#prize-error').textContent = err.message;
      $('#prize-error').hidden = false;
    } finally {
      submit.disabled = false;
    }
  });

  $('#add-prize').addEventListener('click', () => openEditor());

  // ---------- settings ----------

  const settingsForm = $('#settings-form');

  async function loadSettings() {
    const s = await api('/api/admin/settings');
    state.settings = s;
    settingsForm.title.value = s.title;
    settingsForm.subtitle.value = s.subtitle;
    settingsForm.boxCount.value = s.boxCount;
    $('#box-count-out').textContent = s.boxCount;
    settingsForm.boxStyle.value = s.boxStyle || 'gift';
    for (const r of settingsForm.assignment) r.checked = r.value === s.assignment;
    settingsForm.showPrizes.checked = s.showPrizes;
    settingsForm.maxPlaysPerVisitor.value = s.maxPlaysPerVisitor;
    $('#brand-name').textContent = s.title;
    if (state.prizes.length) renderPrizes();
  }

  settingsForm.boxCount.addEventListener('input', () => { $('#box-count-out').textContent = settingsForm.boxCount.value; });

  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#settings-error').hidden = true;
    try {
      await api('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          title: settingsForm.title.value,
          subtitle: settingsForm.subtitle.value,
          boxCount: Number(settingsForm.boxCount.value),
          boxStyle: settingsForm.boxStyle.value,
          assignment: settingsForm.assignment.value,
          showPrizes: settingsForm.showPrizes.checked,
          maxPlaysPerVisitor: Number(settingsForm.maxPlaysPerVisitor.value || 0),
        }),
      });
      await Promise.all([loadSettings(), loadPrizes()]);
      toast('Settings saved');
    } catch (err) {
      $('#settings-error').textContent = err.message;
      $('#settings-error').hidden = false;
    }
  });

  // ---------- rooms ----------

  const roomForm = $('#room-form');

  function populateRoomDefaults() {
    if (!state.settings) return;
    roomForm.style.value = state.settings.boxStyle || 'gift';
    roomForm.boxCount.value = state.settings.boxCount;
  }

  roomForm.addEventListener('input', () => { roomForm.dataset.touched = '1'; });

  function inviteText(code) {
    return `Join at ${location.origin}/join?code=${code} — code ${code}`;
  }

  async function copyInvite(code) {
    try {
      await navigator.clipboard.writeText(inviteText(code));
      toast('Invite copied!');
    } catch {
      toast('Copy failed — please share the code manually.', 'error');
    }
  }

  function showRoomCreated(room) {
    const box = $('#room-created');
    $('#room-created-code').textContent = room.code;
    $('#room-created-open').href = `/admin/room?code=${encodeURIComponent(room.code)}`;
    box.dataset.code = room.code;
    box.hidden = false;
  }

  $('#room-created-copy').addEventListener('click', () => copyInvite($('#room-created').dataset.code));

  roomForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#room-error').hidden = true;
    const body = {
      style: roomForm.style.value,
      boxCount: Number(roomForm.boxCount.value),
    };
    const seconds = roomForm.countdownSeconds.value.trim();
    if (seconds !== '') body.countdownSeconds = Number(seconds);
    const submit = $('button[type=submit]', roomForm);
    submit.disabled = true;
    try {
      const room = await api('/api/admin/rooms', { method: 'POST', body: JSON.stringify(body) });
      showRoomCreated(room);
      toast(`Room ${room.code} created`);
      await loadRooms();
    } catch (err) {
      $('#room-error').textContent = err.message;
      $('#room-error').hidden = false;
    } finally {
      submit.disabled = false;
    }
  });

  function statusChipClass(status) {
    if (status === 'lobby') return 'info';
    if (status === 'finished' || status === 'closed') return 'off';
    if (status === 'locked' || status === 'revealing') return 'warn';
    return '';
  }

  async function loadRooms() {
    if (!roomForm.dataset.touched) populateRoomDefaults();
    state.rooms = await api('/api/admin/rooms');
    renderRooms();
  }

  function renderRooms() {
    const rooms = state.rooms;
    $('#room-empty').hidden = rooms.length > 0;
    $('#room-list').innerHTML = rooms.map((r) => {
      const created = new Date(r.createdAt);
      return `
        <li class="room-row" data-code="${esc(r.code)}">
          <div class="room-row-main">
            <strong class="room-row-code">${esc(r.code)}</strong>
            <span class="chip ${statusChipClass(r.status)}">${esc(r.status)}</span>
          </div>
          <div class="room-row-meta muted">
            ${r.playerCount} player${r.playerCount === 1 ? '' : 's'} · ${r.spectatorCount} spectator${r.spectatorCount === 1 ? '' : 's'} · ${created.toLocaleDateString()} ${created.toLocaleTimeString()}
          </div>
          <div class="room-row-actions">
            <a class="btn btn-ghost" href="/admin/room?code=${encodeURIComponent(r.code)}" target="_blank" rel="noopener">Open</a>
            <button class="btn btn-danger-ghost" data-act="close" type="button">Close</button>
          </div>
        </li>`;
    }).join('');
  }

  $('#room-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act="close"]');
    if (!btn) return;
    const code = btn.closest('.room-row').dataset.code;
    const ok = await confirmDialog({ title: `Close room ${code}?`, text: 'Everyone in this room will be disconnected. This cannot be undone.', ok: 'Close room' });
    if (!ok) return;
    try {
      await api(`/api/admin/rooms/${code}`, { method: 'DELETE' });
      toast(`Room ${code} closed`);
      await loadRooms();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // ---------- winners ----------

  async function loadDraws() {
    state.draws = await api('/api/admin/draws');
    renderDraws();
  }

  function renderDraws() {
    const draws = state.draws;
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
      return !q || (d.code || '').toLowerCase().includes(q) || d.prizeName.toLowerCase().includes(q) || (d.playerName || '').toLowerCase().includes(q);
    });

    $('#draw-empty').hidden = rows.length > 0;
    $('#draw-empty p').textContent = draws.length ? 'Nothing matches your search.' : 'No plays yet.';
    $('#draw-rows').innerHTML = rows.map((d) => {
      const date = new Date(d.createdAt);
      const playerCell = d.playerName
        ? `${esc(d.playerName)}${d.roomId ? ' <span class="chip info">Room</span>' : ''}`
        : '<span class="muted">—</span>';
      return `
        <tr data-id="${esc(d.id)}">
          <td class="when">${date.toLocaleDateString()}<small>${date.toLocaleTimeString()}</small></td>
          <td>${playerCell}</td>
          <td><span class="cell-prize"><span class="cell-emoji">${esc(d.emoji)}</span>${esc(d.prizeName)}</span></td>
          <td>${d.code ? `<span class="code">${esc(d.code)}</span>` : '<span class="muted">— no win —</span>'}</td>
          <td class="right">${d.code ? `<input type="checkbox" class="switch" ${d.redeemed ? 'checked' : ''} aria-label="Redeemed" />` : ''}</td>
        </tr>`;
    }).join('');
  }

  $('#draw-search').addEventListener('input', renderDraws);
  $('#draw-filter').addEventListener('change', renderDraws);

  $('#draw-rows').addEventListener('change', async (e) => {
    if (!e.target.matches('.switch')) return;
    const id = e.target.closest('tr').dataset.id;
    try {
      const updated = await api(`/api/admin/draws/${id}`, { method: 'PATCH', body: JSON.stringify({ redeemed: e.target.checked }) });
      Object.assign(state.draws.find((d) => d.id === id), updated);
      renderDraws();
      toast(updated.redeemed ? `${updated.code} marked as redeemed` : `${updated.code} marked as not redeemed`);
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message, 'error');
    }
  });

  $('#clear-draws').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Clear the winners log?', text: 'All plays and claim codes will be permanently removed. Prize stock is not restored.', ok: 'Clear log' });
    if (!ok) return;
    try {
      await api('/api/admin/draws', { method: 'DELETE' });
      toast('Winners log cleared');
      await loadDraws();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // ---------- boot ----------

  (async () => {
    const { authenticated } = await api('/api/admin/me');
    if (!authenticated) return showLogin();
    await showDash();
    const tab = location.hash.slice(1);
    if (['prizes', 'settings', 'rooms', 'winners'].includes(tab)) selectTab(tab);
  })().catch((err) => toast(err.message, 'error'));
})();
