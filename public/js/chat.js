/* Shared managed-room chat widget (Addendum B2). Used by public/js/room.js (for /room and
 * /watch, `variant: 'floating'`) and public/admin/room.js (host console, `variant: 'embedded'`).
 * Depends on window.FX for sound/reduced-motion. Owns no socket — the page wires
 * chat:history/chat:message/chat:deleted/chat:reaction into the returned handle, and supplies
 * onSend/onReact(/onDelete) callbacks that do the actual socket.emit.
 *
 * Every piece of user-authored text (name, message text) is written with textContent only —
 * never innerHTML — per the contract's "render all chat text with textContent only" rule.
 */
(function () {
  'use strict';

  // Pinned by the server (server/rooms/constants.js CHAT_REACTIONS) — keep in sync.
  const REACTIONS = ['👏', '😂', '😮', '🔥', '❤️', '🎉', '😭', '🤞'];

  // ~24 common emoji for the composer's insert-at-cursor picker (distinct concern from the
  // reaction row above — this is "type this into your message", not "react to the room").
  const EMOJI_PICKER = [
    '😀', '😂', '😍', '😎', '🤔', '👍', '👎', '🙏',
    '🎉', '🔥', '❤️', '😢', '😡', '😴', '🥳', '🤩',
    '😅', '🙌', '👏', '💯', '✨', '🎁', '🍕', '⚽',
  ];

  const MAX_LEN = 200;
  const COUNTER_WARN_AT = 20; // show/emphasize the counter once this few characters remain

  /** True for a message that is 1–3 emoji and nothing else (renders large — contract's
   *  "pleasing touches"). Uses Intl.Segmenter when available for correct grapheme boundaries
   *  (flags, ZWJ sequences); falls back to code-point iteration on older engines. */
  function isEmojiOnly(text) {
    const t = (text || '').trim();
    if (!t) return false;
    let units;
    try {
      if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        units = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t)].map((s) => s.segment);
      } else {
        units = [...t];
      }
    } catch {
      units = [...t];
    }
    if (units.length < 1 || units.length > 3) return false;
    let emojiRe;
    try {
      emojiRe = /^\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic}️?)*$/u;
    } catch {
      return false; // engine has no Unicode property escapes — skip the large-render treatment
    }
    return units.every((u) => emojiRe.test(u));
  }

  function timeLabel(iso) {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  /**
   * @param {object} opts
   * @param {'floating'|'embedded'} opts.variant - 'floating': self-mounts a 💬 FAB + sheet/panel
   *   to document.body (player /room, /watch). 'embedded': renders directly into `opts.mountEl`,
   *   always visible, no FAB (host console).
   * @param {HTMLElement} [opts.mountEl] - required for 'embedded'.
   * @param {boolean} [opts.allowDelete] - host console only: a 🗑 button per message.
   * @param {() => ('player'|'spectator'|'host'|null)} opts.getRole
   * @param {(msg: object) => boolean} opts.isMine
   * @param {(text: string) => Promise<{ok:boolean, error?:string}>} opts.onSend
   * @param {(emoji: string) => void} opts.onReact
   * @param {(id: string) => void} [opts.onDelete]
   * @param {object} opts.sound - window.FX.sound
   * @param {boolean} opts.reducedMotion - window.FX.reducedMotion
   */
  function create(opts) {
    const {
      variant,
      mountEl,
      allowDelete = false,
      getRole,
      isMine,
      onSend,
      onReact,
      onDelete,
      sound,
      reducedMotion,
    } = opts;

    let chatEnabled = true;
    let panelOpen = variant === 'embedded'; // the embedded (host) panel has no closed state
    let unread = 0;
    let atBottom = true;
    let sendBusy = false;
    let slowDownTimer = null;
    let destroyed = false;

    // ---------- DOM ----------

    const shell = document.createElement('div');
    shell.className = `chat-shell chat-${variant}`;

    let fab = null;
    let fabBadge = null;
    if (variant === 'floating') {
      fab = document.createElement('button');
      fab.type = 'button';
      fab.className = 'chat-fab';
      fab.setAttribute('aria-label', 'Open chat');
      const glyph = document.createElement('span');
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = '💬';
      fabBadge = document.createElement('span');
      fabBadge.className = 'chat-fab-badge';
      fabBadge.hidden = true;
      fab.append(glyph, fabBadge);
      shell.appendChild(fab);
    }

    const panel = document.createElement(variant === 'floating' ? 'div' : 'section');
    panel.className = 'chat-panel';
    if (variant === 'floating') {
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'false');
    }
    panel.setAttribute('aria-label', 'Chat');
    shell.appendChild(panel);

    if (variant === 'floating') {
      const dragHandle = document.createElement('div');
      dragHandle.className = 'chat-drag-handle';
      dragHandle.setAttribute('aria-hidden', 'true');
      panel.appendChild(dragHandle);
    }

    const head = document.createElement('div');
    head.className = 'chat-panel-head';
    const titleEl = document.createElement('span');
    titleEl.className = 'chat-panel-title';
    titleEl.textContent = '💬 Chat';
    head.appendChild(titleEl);
    let closeBtn = null;
    if (variant === 'floating') {
      closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'chat-close';
      closeBtn.setAttribute('aria-label', 'Close chat');
      closeBtn.textContent = '✕';
      head.appendChild(closeBtn);
    }
    panel.appendChild(head);

    const offNote = document.createElement('p');
    offNote.className = 'chat-off-note';
    offNote.textContent = 'Chat is turned off by the host.';
    offNote.hidden = true;
    panel.appendChild(offNote);

    const watchNote = document.createElement('p');
    watchNote.className = 'chat-watch-note';
    watchNote.textContent = 'Watchers can react — join with the player link to chat.';
    watchNote.hidden = true;
    panel.appendChild(watchNote);

    const messagesWrap = document.createElement('div');
    messagesWrap.className = 'chat-messages-wrap';
    const messagesEl = document.createElement('ul');
    messagesEl.className = 'chat-messages';
    messagesEl.setAttribute('aria-label', 'Chat messages');
    // Starts "off" so the initial history dump (up to 50/100 messages) isn't read aloud —
    // flipped to "polite" right after the first render. See history() below.
    messagesEl.setAttribute('aria-live', 'off');
    messagesWrap.appendChild(messagesEl);
    const jumpBtn = document.createElement('button');
    jumpBtn.type = 'button';
    jumpBtn.className = 'chat-jump';
    jumpBtn.textContent = 'New messages ↓';
    jumpBtn.hidden = true;
    messagesWrap.appendChild(jumpBtn);
    panel.appendChild(messagesWrap);

    const reactionsRow = document.createElement('div');
    reactionsRow.className = 'chat-reactions';
    reactionsRow.setAttribute('role', 'group');
    reactionsRow.setAttribute('aria-label', 'Send a reaction');
    for (const emoji of REACTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-reaction-btn';
      btn.textContent = emoji;
      btn.setAttribute('aria-label', `React with ${emoji}`);
      btn.addEventListener('click', () => {
        if (!chatEnabled) return;
        onReact(emoji);
        floatReaction(emoji);
      });
      reactionsRow.appendChild(btn);
    }
    panel.appendChild(reactionsRow);

    const composerForm = document.createElement('form');
    composerForm.className = 'chat-composer';
    composerForm.setAttribute('autocomplete', 'off');

    const emojiPopover = document.createElement('div');
    emojiPopover.className = 'chat-emoji-popover';
    emojiPopover.hidden = true;
    for (const emoji of EMOJI_PICKER) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = emoji;
      btn.setAttribute('aria-label', `Insert ${emoji}`);
      btn.addEventListener('click', () => insertAtCursor(emoji));
      emojiPopover.appendChild(btn);
    }

    const composerRow = document.createElement('div');
    composerRow.className = 'chat-composer-row';
    const emojiBtn = document.createElement('button');
    emojiBtn.type = 'button';
    emojiBtn.className = 'chat-emoji-btn';
    emojiBtn.setAttribute('aria-label', 'Insert emoji');
    emojiBtn.setAttribute('aria-expanded', 'false');
    emojiBtn.textContent = '🙂';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'chat-input';
    input.maxLength = MAX_LEN;
    input.placeholder = 'Say something…';
    input.setAttribute('aria-label', 'Message');
    const sendBtn = document.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.className = 'chat-send';
    sendBtn.textContent = 'Send';
    composerRow.append(emojiBtn, input, sendBtn);
    composerForm.append(emojiPopover, composerRow);

    const counter = document.createElement('span');
    counter.className = 'chat-counter';
    counter.hidden = true;
    const hint = document.createElement('p');
    hint.className = 'chat-hint';
    hint.hidden = true;
    composerForm.append(counter, hint);
    panel.appendChild(composerForm);

    // A full-viewport, pointer-events:none overlay that floating reactions animate up through —
    // shared across variants so a reaction always reads as "over the game", not clipped to
    // whichever panel is currently open/closed.
    const reactionLayer = document.createElement('div');
    reactionLayer.className = 'chat-reaction-layer';
    reactionLayer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(reactionLayer);

    if (variant === 'embedded' && mountEl) mountEl.appendChild(shell);
    else document.body.appendChild(shell);

    // ---------- rendering helpers ----------

    function isNearBottom() {
      return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      atBottom = true;
      jumpBtn.hidden = true;
    }

    function buildMessageRow(m) {
      const li = document.createElement('li');
      const mine = isMine(m);
      const emojiOnly = isEmojiOnly(m.text);
      li.className = `chat-msg${mine ? ' is-mine' : ''}${m.authorRole === 'host' ? ' is-host' : ''}${emojiOnly ? ' is-emoji-only' : ''}`;
      li.dataset.id = m.id;
      if (m.color) li.style.setProperty('--msg-color', m.color);

      if (!mine) {
        const avatar = document.createElement('span');
        avatar.className = 'chat-msg-avatar';
        avatar.setAttribute('aria-hidden', 'true');
        // Host messages carry color:null, avatar:null (there's no per-host player row) — give
        // them a distinct fallback glyph so they don't read as just another anonymous player.
        avatar.textContent = m.avatar || (m.authorRole === 'host' ? '🎙️' : '🙂');
        li.appendChild(avatar);
      }

      const body = document.createElement('div');
      body.className = 'chat-msg-body';

      if (!mine) {
        const meta = document.createElement('div');
        meta.className = 'chat-msg-meta';
        const name = document.createElement('span');
        name.className = 'chat-msg-name';
        name.textContent = m.name || (m.authorRole === 'host' ? 'Host' : 'Someone');
        meta.appendChild(name);
        if (m.authorRole === 'host') {
          const badge = document.createElement('span');
          badge.className = 'chat-msg-host-badge';
          badge.textContent = 'Host';
          meta.appendChild(badge);
        }
        const time = document.createElement('span');
        time.className = 'chat-msg-time';
        time.textContent = timeLabel(m.createdAt);
        meta.appendChild(time);
        body.appendChild(meta);
      }

      const textEl = document.createElement('div');
      textEl.className = 'chat-msg-text';
      textEl.textContent = m.text; // textContent only — never HTML.
      body.appendChild(textEl);
      li.appendChild(body);

      if (allowDelete) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'chat-msg-delete';
        del.setAttribute('aria-label', 'Delete message');
        del.textContent = '🗑';
        del.addEventListener('click', () => {
          del.disabled = true;
          onDelete(m.id);
          // If the delete failed (host action rejected/timed out), the row never gets removed
          // by deleted() below — re-enable so it isn't stuck disabled forever. A no-op once the
          // row (and this now-detached button) has already been removed by a successful delete.
          setTimeout(() => { del.disabled = false; }, 4000);
        });
        li.appendChild(del);
      }

      return li;
    }

    function appendMessage(m, { silent = false } = {}) {
      const wasNearBottom = isNearBottom();
      const li = buildMessageRow(m);
      if (!silent) li.classList.add('chat-msg-pop');
      messagesEl.appendChild(li);
      // Always follow your own message, even if you had scrolled up to read older ones.
      if (wasNearBottom || silent || isMine(m)) scrollToBottom();
      else { atBottom = false; jumpBtn.hidden = false; }

      if (!silent) {
        const mine = isMine(m);
        if (!mine && sound && !sound.muted) sound.chime();
        if (variant === 'floating' && !panelOpen && !mine) {
          unread += 1;
          renderUnread();
        }
      }
    }

    function renderUnread() {
      if (!fabBadge) return;
      fabBadge.textContent = unread > 9 ? '9+' : String(unread);
      fabBadge.hidden = unread === 0;
      fab.setAttribute('aria-label', unread > 0 ? `Open chat, ${unread} unread` : 'Open chat');
    }

    function floatReaction(emoji) {
      const span = document.createElement('span');
      span.className = 'chat-floating-reaction';
      span.textContent = emoji;
      span.style.left = `${8 + Math.random() * 84}%`;
      if (reducedMotion) span.classList.add('is-reduced-motion');
      reactionLayer.appendChild(span);
      span.addEventListener('animationend', () => span.remove());
      // Belt-and-braces: guarantee cleanup even if animationend never fires (e.g. the tab was
      // backgrounded through the whole animation).
      setTimeout(() => span.remove(), reducedMotion ? 1400 : 2400);
    }

    function insertAtCursor(text) {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      const next = input.value.slice(0, start) + text + input.value.slice(end);
      input.value = next.slice(0, MAX_LEN);
      const pos = Math.min(start + text.length, MAX_LEN);
      input.setSelectionRange(pos, pos);
      input.focus();
      updateCounter();
    }

    function updateCounter() {
      const remaining = MAX_LEN - input.value.length;
      counter.hidden = input.value.length === 0;
      counter.textContent = `${remaining}`;
      counter.classList.toggle('is-warn', remaining <= COUNTER_WARN_AT);
    }

    function applyComposerAvailability() {
      const role = getRole ? getRole() : null;
      const canCompose = chatEnabled && role !== 'spectator' && role !== null;
      composerForm.hidden = !canCompose;
      reactionsRow.hidden = !chatEnabled;
      offNote.hidden = chatEnabled;
      watchNote.hidden = !(chatEnabled && role === 'spectator');
      if (fab) fab.classList.toggle('is-off', !chatEnabled);
    }

    // ---------- open / close (floating variant) ----------

    function setOpen(next) {
      panelOpen = next;
      shell.classList.toggle('is-open', next);
      if (fab) fab.setAttribute('aria-expanded', String(next));
      if (next) {
        unread = 0;
        renderUnread();
        scrollToBottom();
        requestAnimationFrame(() => input.focus({ preventScroll: true }));
      }
    }

    if (fab) fab.addEventListener('click', () => setOpen(!panelOpen));
    if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));

    // ---------- composer wiring ----------

    input.addEventListener('input', updateCounter);
    emojiBtn.addEventListener('click', () => {
      const next = emojiPopover.hidden;
      emojiPopover.hidden = !next;
      emojiBtn.setAttribute('aria-expanded', String(next));
    });
    document.addEventListener('click', (e) => {
      if (emojiPopover.hidden) return;
      if (e.target === emojiBtn || emojiPopover.contains(e.target)) return;
      emojiPopover.hidden = true;
      emojiBtn.setAttribute('aria-expanded', 'false');
    });

    function showSlowDown(message) {
      hint.textContent = message;
      hint.hidden = false;
      input.disabled = true;
      sendBtn.disabled = true;
      clearTimeout(slowDownTimer);
      slowDownTimer = setTimeout(() => {
        hint.hidden = true;
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
      }, 1500);
    }

    composerForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (sendBusy || destroyed) return;
      const text = input.value.trim();
      if (!text) return;
      sendBusy = true;
      sendBtn.disabled = true;
      onSend(text).then((res) => {
        sendBusy = false;
        if (destroyed) return;
        if (res && res.ok === false) {
          sendBtn.disabled = false;
          if (/slow down/i.test(res.error || '')) {
            showSlowDown(res.error);
          } else {
            hint.textContent = res.error || 'Could not send that.';
            hint.hidden = false;
          }
          return;
        }
        input.value = '';
        updateCounter();
        hint.hidden = true;
        sendBtn.disabled = false;
        // Keep focus on the input on mobile so a quick back-and-forth doesn't need re-tapping.
        input.focus({ preventScroll: true });
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
          try { navigator.vibrate(10); } catch { /* unsupported/blocked — not worth surfacing */ }
        }
      }).catch(() => {
        sendBusy = false;
        sendBtn.disabled = false;
      });
    });

    jumpBtn.addEventListener('click', scrollToBottom);
    messagesEl.addEventListener('scroll', () => {
      if (isNearBottom()) { atBottom = true; jumpBtn.hidden = true; }
    });

    // ---------- public API ----------

    function history(list) {
      if (destroyed) return;
      messagesEl.setAttribute('aria-live', 'off');
      messagesEl.replaceChildren();
      for (const m of list || []) appendMessage(m, { silent: true });
      scrollToBottom();
      // Flip back to "polite" on the next frame so this bulk render itself was never announced —
      // only messages appended after this point are.
      requestAnimationFrame(() => { if (!destroyed) messagesEl.setAttribute('aria-live', 'polite'); });
    }

    function message(m) {
      if (destroyed) return;
      appendMessage(m, { silent: false });
    }

    function deleted(id) {
      if (destroyed) return;
      const row = messagesEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (row) row.remove();
    }

    function reaction(msg) {
      if (destroyed || !msg || !msg.emoji) return;
      floatReaction(msg.emoji);
    }

    /** Called from the page's room:state handler with `{chatEnabled}`. */
    function applyRoomState({ chatEnabled: enabled } = {}) {
      if (destroyed) return;
      chatEnabled = Boolean(enabled);
      applyComposerAvailability();
    }

    applyComposerAvailability();

    function destroy() {
      destroyed = true;
      clearTimeout(slowDownTimer);
      shell.remove();
      reactionLayer.remove();
    }

    return { history, message, deleted, reaction, applyRoomState, destroy };
  }

  window.Chat = { create, REACTIONS, isEmojiOnly };
})();
