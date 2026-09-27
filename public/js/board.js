/* Shared multiplayer box board: renders RoomView.boxes, live locks/hands, and the reveal
 * sequence. Used by the player room page (interactive:true, showHands:true) and, per the P4
 * plan, by the P5 host console (interactive:false, showHands:true). Depends on window.Boxes
 * (box factory/layout) and window.FX (confetti/sound); styling for the classes this file adds
 * (.hands-layer, .hand, .owner-chip, .is-locked, .is-mine, .no-anim) lives in public/css/room.css
 * — a consumer must link that stylesheet (or an equivalent) for those to render correctly.
 */
(function () {
  'use strict';

  const HAND_STALE_MS = 5000;
  const CURSOR_THROTTLE_MS = 50;
  const LERP = 0.25;

  function clamp01(n) {
    return Math.max(0, Math.min(1, n));
  }

  function prizeArt(prize) {
    if (!prize) return document.createTextNode('❔');
    if (prize.image) {
      const img = document.createElement('img');
      img.src = prize.image;
      img.alt = '';
      img.loading = 'lazy';
      return img;
    }
    return document.createTextNode(prize.emoji || '🎁');
  }

  function fillBox(box, prize) {
    const slot = box.querySelector('.box-prize');
    slot.replaceChildren(prizeArt(prize));
    box.querySelector('.box-label').textContent = prize ? prize.name : 'Out of stock';
    box.style.setProperty('--prize', prize ? prize.color : '#94a3b8');
  }

  /**
   * Build one board over `rootEl` (a `.boxes` container element — becomes the box grid itself).
   * See the P4 plan for the full contract. `onCursor`/`onCursorHide` are additive (not in the
   * pinned signature) — the page forwards their payloads to the `cursor:move`/`cursor:hide`
   * socket events. `onTaken(name)` is also additive: fired instead of `onPick` when the clicked
   * box is locked by someone else, so the page can show a "Taken by <name>" toast without a
   * round trip (a stale click that races a real lock still surfaces via the page's ack-error
   * toast path).
   */
  function create(rootEl, opts = {}) {
    const { onPick, onUnpick, onTaken, interactive = true, showHands = false, getSelfId, onCursor, onCursorHide } = opts;

    rootEl.style.position = 'relative';

    let boxEls = [];
    let boxCount = 0;
    let style = 'gift';
    let curView = null;
    let firstRender = true;
    let destroyed = false;

    // ---------- hands overlay ----------

    let handsEl = null;
    const hands = new Map(); // playerId -> { el, b, x, y, cx, cy, lastUpdate, visible }
    let rafId = null;

    if (showHands) {
      handsEl = document.createElement('div');
      handsEl.className = 'hands-layer';
      handsEl.setAttribute('aria-hidden', 'true');
      rootEl.appendChild(handsEl);
    }

    function ensureHandEl(playerId) {
      let hand = hands.get(playerId);
      if (hand) return hand;
      const el = document.createElement('div');
      el.className = 'hand';
      el.dataset.playerId = playerId;
      el.innerHTML = '<span class="hand-glyph" aria-hidden="true">🖐️</span><span class="hand-name"></span>';
      handsEl.appendChild(el);
      hand = { el, b: null, x: 0, y: 0, cx: null, cy: null, lastUpdate: 0, visible: false };
      hands.set(playerId, hand);
      return hand;
    }

    function handCursor(msg) {
      if (!showHands || !msg || destroyed) return;
      const selfId = getSelfId ? getSelfId() : null;
      if (msg.playerId == null || msg.playerId === selfId) return;
      const hand = ensureHandEl(msg.playerId);
      hand.b = msg.b === null || msg.b === undefined ? null : Number(msg.b);
      hand.x = clamp01(msg.x);
      hand.y = clamp01(msg.y);
      hand.lastUpdate = Date.now();
      if (!hand.visible) hand.cx = null; // reappearing after a hide/staleness: snap, don't fly in
      hand.visible = true;
    }

    function hideCursor(playerId) {
      const hand = hands.get(playerId);
      if (hand) hand.visible = false;
    }

    function computeTargetPx(hand) {
      const hrect = handsEl.getBoundingClientRect();
      let rect;
      if (hand.b !== null && boxEls[hand.b]) rect = boxEls[hand.b].getBoundingClientRect();
      else rect = rootEl.getBoundingClientRect();
      return { x: rect.left - hrect.left + rect.width * hand.x, y: rect.top - hrect.top + rect.height * hand.y };
    }

    function tick() {
      if (destroyed) return;
      const now = Date.now();
      const targets = new Map();
      for (const [playerId, hand] of hands) {
        const stale = now - hand.lastUpdate > HAND_STALE_MS;
        if (stale || !hand.visible) continue;
        targets.set(playerId, computeTargetPx(hand));
      }
      for (const [playerId, hand] of hands) {
        const target = targets.get(playerId);
        if (!target) {
          hand.el.style.opacity = '0';
          continue;
        }
        const lerp = window.FX && window.FX.reducedMotion ? 1 : LERP;
        if (hand.cx === null || hand.cy === null) {
          hand.cx = target.x;
          hand.cy = target.y;
        } else {
          hand.cx += (target.x - hand.cx) * lerp;
          hand.cy += (target.y - hand.cy) * lerp;
        }
        hand.el.style.transform = `translate(${hand.cx}px, ${hand.cy}px) translate(-50%, -50%)`;
        hand.el.style.opacity = '1';
        const owner = curView && curView.players.find((p) => p.id === playerId);
        if (owner) {
          hand.el.style.setProperty('--hand-color', owner.color);
          const nameEl = hand.el.querySelector('.hand-name');
          if (nameEl.textContent !== owner.name) nameEl.textContent = owner.name;
        }
      }
      rafId = requestAnimationFrame(tick);
    }

    if (showHands) rafId = requestAnimationFrame(tick);

    // ---------- local pointer ----------

    let lastEmitAt = 0;
    let pendingTimer = null;
    let lastMsg = null;

    function doEmit(msg) {
      lastEmitAt = Date.now();
      if (onCursor) onCursor(msg);
    }

    function scheduleEmit(msg) {
      lastMsg = msg;
      const elapsed = Date.now() - lastEmitAt;
      if (elapsed >= CURSOR_THROTTLE_MS) {
        doEmit(msg);
      } else if (!pendingTimer) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          doEmit(lastMsg);
        }, CURSOR_THROTTLE_MS - elapsed);
      }
    }

    function cancelPending() {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    }

    function handlePointerMove(e) {
      // document.elementFromPoint (not e.target): touch pointers implicitly capture to their
      // pointerdown target, so e.target would stay "stuck" to the first box touched during a
      // drag across the board instead of following the finger.
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const boxEl = under && under.closest ? under.closest('.box') : null;
      let b = null;
      let x;
      let y;
      if (boxEl && boxEl.parentElement === rootEl) {
        const rect = boxEl.getBoundingClientRect();
        b = Number(boxEl.dataset.index);
        x = clamp01((e.clientX - rect.left) / rect.width);
        y = clamp01((e.clientY - rect.top) / rect.height);
      } else {
        const rect = rootEl.getBoundingClientRect();
        x = clamp01((e.clientX - rect.left) / rect.width);
        y = clamp01((e.clientY - rect.top) / rect.height);
      }
      scheduleEmit({ b, x, y });
    }

    function handlePointerLeave() {
      cancelPending();
      if (onCursorHide) onCursorHide();
    }

    const wantsCursor = typeof onCursor === 'function';
    if (wantsCursor) {
      rootEl.addEventListener('pointermove', handlePointerMove);
      rootEl.addEventListener('pointerleave', handlePointerLeave);
      rootEl.addEventListener('pointercancel', handlePointerLeave);
    }

    // ---------- layout (copied from public/js/app.js `layout()`, including the aspect factor) ----------

    function layout() {
      const n = boxEls.length;
      if (!n) return;
      const width = Math.min(innerWidth, 1080) - 48;
      const gap = Math.max(14, Math.min(36, innerWidth * 0.03));
      const preferred = n <= 5 ? n : { 6: 3, 7: 4, 8: 4, 9: 5, 10: 5, 11: 6, 12: 6 }[n];
      const sizeFor = (cols) => (width - (cols - 1) * gap) / cols;
      let cols = preferred;
      while (cols > 2 && sizeFor(cols) < 118) cols--;
      let size = Math.max(96, Math.min(190, sizeFor(cols)));

      const factor = Math.min(1, window.Boxes.aspect(style) / window.Boxes.aspect('gift'));
      size *= factor;

      rootEl.style.setProperty('--cols', cols);
      rootEl.style.setProperty('--box-size', `${Math.floor(size)}px`);
    }

    let resizeTimer;
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(layout, 100);
    }
    addEventListener('resize', onResize);

    // ---------- box grid ----------

    function ownerNameFor(playerId) {
      const p = curView && curView.players.find((pl) => pl.id === playerId);
      return p ? p.name : 'someone';
    }

    function handleClick(i) {
      if (!curView || destroyed) return;
      if (curView.status !== 'picking') return;
      if (!curView.me || curView.me.role !== 'player') return;
      const bv = curView.boxes[i];
      if (!bv || bv.revealed) return;
      const selfId = getSelfId ? getSelfId() : null;
      if (!bv.playerId) {
        if (onPick) onPick(i);
      } else if (selfId != null && bv.playerId === selfId) {
        if (onUnpick) onUnpick();
      } else if (onTaken) {
        onTaken(ownerNameFor(bv.playerId));
      }
    }

    function makeBox(i) {
      const box = window.Boxes.createBox(i, style);
      const chip = document.createElement('span');
      chip.className = 'owner-chip';
      chip.hidden = true;
      chip.innerHTML = '<span class="owner-avatar"></span><span class="owner-name"></span>';
      box.appendChild(chip);
      if (interactive) box.addEventListener('click', () => handleClick(i));
      return box;
    }

    function ensureBoxes(count, boxStyle) {
      style = boxStyle;
      if (count !== boxCount) {
        for (const el of boxEls) el.remove();
        boxEls = Array.from({ length: count }, (_, i) => makeBox(i));
        // Insert before the hands layer (if any) so it stays the overlay on top.
        for (const el of boxEls) rootEl.insertBefore(el, handsEl || null);
        boxCount = count;
      }
      window.Boxes.setStyle(rootEl, boxStyle);
      layout();
    }

    function render(view) {
      if (destroyed) return;
      ensureBoxes(view.boxCount, view.style);

      const selfId = getSelfId ? getSelfId() : null;
      const canAct = interactive && view.status === 'picking' && view.me && view.me.role === 'player';
      rootEl.style.touchAction = view.status === 'picking' ? 'none' : '';
      rootEl.dataset.state = canAct ? 'picking' : view.status === 'lobby' ? 'idle' : view.status;

      const playersById = new Map(view.players.map((p) => [p.id, p]));
      let anyNewlyRevealed = false;

      for (let i = 0; i < view.boxCount; i++) {
        const box = boxEls[i];
        const bv = view.boxes[i];
        const prevBv = curView && curView.boxes[i];
        const wasRevealed = Boolean(prevBv && prevBv.revealed);
        const nowRevealed = Boolean(bv.revealed);
        const chip = box.querySelector('.owner-chip');

        box.classList.remove('is-locked', 'is-mine');
        box.style.removeProperty('--owner');
        chip.hidden = true;

        if (nowRevealed) {
          if (!wasRevealed) {
            fillBox(box, bv.prize);
            if (firstRender) box.classList.add('no-anim');
            box.classList.add('is-open');
            anyNewlyRevealed = true;
            if (!firstRender && bv.prize && bv.prize.winning && selfId != null && bv.playerId === selfId) {
              const r = box.getBoundingClientRect();
              window.FX.burst({ x: r.left + r.width / 2, y: r.top + r.height * 0.3, count: 180, colors: [bv.prize.color] });
            }
          }
          box.classList.remove('is-dim');
          box.classList.toggle('is-chosen', Boolean(bv.playerId));
          box.classList.toggle('is-other', !bv.playerId);
          if (selfId != null && bv.playerId === selfId) box.classList.add('is-mine');
          box.setAttribute(
            'aria-label',
            selfId != null && bv.playerId === selfId
              ? `Your box — ${bv.prize ? bv.prize.name : 'no prize'}`
              : bv.playerId
                ? `Box ${i + 1} — ${ownerNameFor(bv.playerId)}'s box`
                : `Box ${i + 1}`,
          );
          box.tabIndex = -1;
          box.setAttribute('aria-disabled', 'true');
        } else {
          box.classList.remove('is-open', 'is-chosen', 'is-other', 'is-dim');
          if (bv.playerId) {
            box.classList.add('is-locked');
            const owner = playersById.get(bv.playerId);
            if (owner) {
              box.style.setProperty('--owner', owner.color);
              chip.hidden = false;
              chip.querySelector('.owner-avatar').textContent = owner.avatar;
              chip.querySelector('.owner-name').textContent = owner.name;
            }
            if (selfId != null && bv.playerId === selfId) box.classList.add('is-mine');
          }
          const clickable = canAct;
          box.setAttribute('aria-disabled', clickable ? 'false' : 'true');
          box.tabIndex = clickable ? 0 : -1;
          box.setAttribute(
            'aria-label',
            selfId != null && bv.playerId === selfId
              ? 'Your box — tap to release'
              : bv.playerId
                ? `Box ${i + 1} — taken by ${ownerNameFor(bv.playerId)}`
                : `Lock box ${i + 1}`,
          );
        }
      }

      curView = view;
      if (anyNewlyRevealed && !firstRender) window.FX.sound.pop();
      firstRender = false;
    }

    function destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      cancelPending();
      removeEventListener('resize', onResize);
      if (wantsCursor) {
        rootEl.removeEventListener('pointermove', handlePointerMove);
        rootEl.removeEventListener('pointerleave', handlePointerLeave);
        rootEl.removeEventListener('pointercancel', handlePointerLeave);
      }
      rootEl.replaceChildren();
      hands.clear();
      boxEls = [];
    }

    return { render, handCursor, hideCursor, destroy };
  }

  window.Board = { create };
})();
