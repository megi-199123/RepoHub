(function () {
  'use strict';

  const { burst, rain, sound, startStars, reducedMotion } = window.FX;

  const $ = (id) => document.getElementById(id);
  const els = {
    main: document.querySelector('main.app'),
    title: $('title'),
    subtitle: $('subtitle'),
    lineup: $('lineup'),
    lineupList: $('lineup-list'),
    hint: $('hint'),
    stage: document.querySelector('.stage'),
    controls: document.querySelector('.controls'),
    stateScreen: $('state-screen'),
    stateTitle: $('state-title'),
    stateMessage: $('state-message'),
    boxes: $('boxes'),
    play: $('play'),
    playLabel: $('play-label'),
    playsLeft: $('plays-left'),
    reveal: $('reveal'),
    revealCard: document.querySelector('.reveal-card'),
    revealKicker: $('reveal-kicker'),
    revealArt: $('reveal-art'),
    revealTitle: $('reveal-title'),
    revealDesc: $('reveal-desc'),
    revealClaim: $('reveal-claim'),
    claimCode: $('claim-code'),
    revealClose: $('reveal-close'),
    toast: $('toast'),
    sound: $('sound-toggle'),
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Tenant rooms: this page is always reached as /play?code=XXXXXX — every game endpoint is
  // scoped under that room code (see the frozen contract, "Public (players)").
  const code = (new URLSearchParams(location.search).get('code') || '').trim();

  let config = null;
  let state = 'loading'; // idle | shuffling | picking | opening | revealed
  let round = null;
  let result = null;

  // ---------- helpers ----------

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    const data = res.status === 204 ? null : await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error || 'Something went wrong. Please try again.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /** Swap the whole page over to a friendly dead-end (missing/invalid code, room not found,
   *  ended, hosted live, or rate-limited) with a link back to "/" to try another code — used
   *  both at boot and if a room disappears mid-session (refreshConfig below). */
  function showFriendlyState(message, title) {
    state = 'blocked';
    els.lineup.hidden = true;
    if (els.stage) els.stage.hidden = true;
    if (els.controls) els.controls.hidden = true;
    // Unhide the aria-live region BEFORE writing its text — some screen readers only announce
    // a live-region mutation if the region was already visible/in the render tree when it happened.
    els.stateScreen.hidden = false;
    els.stateTitle.textContent = title || "Can't join this room";
    // The server message for a 404 is the same as the title ("Room not found"); do not repeat it.
    els.stateMessage.textContent = message === title ? 'Check the code and try again.' : message;
    document.title = title || 'Mystery Box';
  }

  let toastTimer;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3200);
  }

  function setHint(text) {
    els.hint.textContent = text;
    els.hint.classList.remove('bump');
    void els.hint.offsetWidth;
    els.hint.classList.add('bump');
  }

  function setState(next) {
    state = next;
    els.boxes.dataset.state = next;
    for (const box of els.boxes.children) {
      box.disabled = next !== 'picking';
      box.tabIndex = next === 'picking' ? 0 : -1;
    }
  }

  function prizeArt(prize) {
    if (prize.image) {
      const img = document.createElement('img');
      img.src = prize.image;
      img.alt = '';
      img.loading = 'lazy';
      return img;
    }
    return document.createTextNode(prize.emoji || '🎁');
  }

  /** B1: true when this prize's image should render with no tile/border/frame (a transparent
   *  PNG or logo) — never true for an emoji-only prize. Toggled as a class on whichever
   *  container (.lineup-art / .box-prize / .reveal-art) holds the art; see app.css. */
  function noBorder(prize) {
    return Boolean(prize && prize.image && prize.imageBorder === false);
  }

  function renderPlaysLeft(playsLeft) {
    if (playsLeft === null || playsLeft === undefined) {
      els.playsLeft.hidden = true;
      return;
    }
    els.playsLeft.hidden = false;
    els.playsLeft.innerHTML = playsLeft > 0
      ? `You have <strong>${playsLeft}</strong> ${playsLeft === 1 ? 'play' : 'plays'} left`
      : "You've used all your plays — thanks for playing!";
  }

  // ---------- rendering ----------

  function renderLineup(prizes) {
    els.lineup.hidden = prizes.length === 0;
    els.lineupList.replaceChildren(
      ...prizes.map((p, i) => {
        const li = document.createElement('li');
        li.className = 'lineup-item';
        li.style.setProperty('--i', i);
        li.style.setProperty('--c', p.color);
        const art = document.createElement('span');
        art.className = `lineup-art${noBorder(p) ? ' no-border' : ''}`;
        art.append(prizeArt(p));
        const name = document.createElement('span');
        name.className = 'lineup-name';
        name.textContent = p.name;
        li.append(art, name);
        return li;
      }),
    );
  }

  function createBox(i) {
    const box = window.Boxes.createBox(i, (config && config.boxStyle) || 'gift');
    box.addEventListener('click', () => pick(box));
    return box;
  }

  function renumber() {
    [...els.boxes.children].forEach((box, i) => {
      box.dataset.index = i;
      box.querySelector('.box-number').textContent = i + 1;
      box.setAttribute('aria-label', `Open box ${i + 1}`);
    });
  }

  function renderBoxes(count) {
    els.boxes.replaceChildren(...Array.from({ length: count }, (_, i) => createBox(i)));
    renumber();
    layout();
  }

  /** Pick a column count and box size that fit the viewport nicely. */
  function layout() {
    const n = els.boxes.children.length;
    if (!n) return;
    const width = Math.min(innerWidth, 1080) - 48; // page gutter + grid padding
    const gap = Math.max(14, Math.min(36, innerWidth * 0.03));
    const preferred = n <= 5 ? n : { 6: 3, 7: 4, 8: 4, 9: 5, 10: 5, 11: 6, 12: 6 }[n];
    const sizeFor = (cols) => (width - (cols - 1) * gap) / cols;
    let cols = preferred;
    while (cols > 2 && sizeFor(cols) < 118) cols--;
    let size = Math.max(96, Math.min(190, sizeFor(cols)));

    // Styles taller than gift (e.g. card) would otherwise make the whole grid
    // ~1.4x taller at the same width; shrink --box-size so rendered height stays
    // comparable to gift's. Styles no taller than gift (e.g. suitcase) are left
    // as-is — factor caps at 1, so gift itself is always the unchanged 1x path.
    const style = (config && config.boxStyle) || 'gift';
    const factor = Math.min(1, window.Boxes.aspect(style) / window.Boxes.aspect('gift'));
    size *= factor;

    els.boxes.style.setProperty('--cols', cols);
    els.boxes.style.setProperty('--box-size', `${Math.floor(size)}px`);
  }

  // ---------- shuffle (FLIP animation) ----------

  function permutation(list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    // Make sure something visibly moves.
    if (out.length > 1 && out.every((el, i) => el === list[i])) out.push(out.shift());
    return out;
  }

  async function shuffle(times) {
    for (let t = 0; t < times; t++) {
      const boxes = [...els.boxes.children];
      const before = new Map(boxes.map((b) => [b, b.getBoundingClientRect()]));
      const order = permutation(boxes);
      els.boxes.append(...order);
      const duration = reducedMotion ? 120 : Math.max(230, 460 - t * 40);
      sound.swoosh();
      await Promise.all(order.map((box, i) => {
        const a = before.get(box);
        const b = box.getBoundingClientRect();
        const dx = a.left - b.left;
        const dy = a.top - b.top;
        const lift = (i % 2 ? -1 : 1) * (dx || dy ? 46 : 12);
        return box.animate([
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: `translate(${dx / 2}px, ${dy / 2 + lift}px) scale(0.9) rotate(${lift / 6}deg)`, offset: 0.5 },
          { transform: 'translate(0, 0)' },
        ], { duration, easing: 'cubic-bezier(.45,0,.25,1)' }).finished;
      }));
    }
    renumber();
  }

  // ---------- box contents ----------

  function fillBox(box, prize, labelKind) {
    const slot = box.querySelector('.box-prize');
    slot.replaceChildren(prizeArt(prize));
    slot.classList.toggle('no-border', noBorder(prize));
    box.querySelector('.box-label').textContent = prize.name;
    box.style.setProperty('--prize', prize.color);
    // C3 (code audit): box aria-labels used to stay "Open box N" forever, even once revealed
    // — a screen-reader user got no account of what was actually inside any box.
    const n = Number(box.dataset.index) + 1;
    box.setAttribute('aria-label', labelKind === 'mine' ? `Your box — ${prize.name}` : `Box ${n} — ${prize.name}`);
  }

  /** Cycle Tab/Shift+Tab between the first and last focusable element inside `container`
   *  (used for the reveal modal's focus trap, alongside `inert` on the rest of the page). */
  function trapTab(e, container) {
    const list = [...container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /** Focus the first pickable box — used to recover keyboard focus after the box grid is
   *  torn down and rebuilt (M1, browser audit: focus silently fell back to <body>). Only
   *  moves focus if the caller confirms focus would otherwise be lost/stranded. */
  function focusFirstBox() {
    const first = els.boxes.querySelector('.box:not(:disabled)') || els.boxes.querySelector('.box');
    if (first) first.focus();
  }

  async function closeAllBoxes() {
    const boxes = [...els.boxes.children];
    const anyOpen = boxes.some((b) => b.classList.contains('is-open'));
    for (const box of boxes) box.classList.remove('is-open', 'is-chosen', 'is-other', 'is-dim', 'is-shaking');
    if (anyOpen) await wait(reducedMotion ? 150 : 700);
    for (const box of boxes) {
      box.querySelector('.box-prize').replaceChildren();
      box.querySelector('.box-label').textContent = '';
    }
  }

  // ---------- game flow ----------

  async function play() {
    if (!['idle', 'revealed'].includes(state)) return;
    // M1 (browser audit): disabling — and, when the box count changed, rebuilding — the box
    // grid drops keyboard focus to <body>. Remember whether focus was keyboard-reachable here
    // (Play, or already lost to body from an earlier render) so it can be restored below.
    const shouldRefocus = document.activeElement === els.play || document.activeElement === document.body;
    els.play.disabled = true;
    setState('shuffling');
    setHint('Shuffling the boxes…');

    try {
      await closeAllBoxes();
      const [newRound] = await Promise.all([
        api(`/api/rooms/${code}/rounds`, { method: 'POST' }),
        shuffle(reducedMotion ? 1 : 7),
      ]);
      round = newRound;
      // The backoffice may have changed the box count since the page loaded.
      if (round.boxCount !== els.boxes.children.length) renderBoxes(round.boxCount);
      setState('picking');
      setHint('Pick a box! 👇');
      els.playLabel.textContent = 'Shuffle again';
      els.play.disabled = false;
      if (shouldRefocus) focusFirstBox();
    } catch (err) {
      toast(err.message);
      setState('idle');
      setHint('Tap the button to try again');
      els.play.disabled = false;
      if (shouldRefocus) els.play.focus();
      refreshConfig();
    }
  }

  async function reshuffle() {
    // Allow reshuffling while picking — same round, just a fresh visual shuffle.
    const shouldRefocus = document.activeElement === els.play || document.activeElement === document.body;
    els.play.disabled = true;
    setState('shuffling');
    setHint('Shuffling again…');
    await shuffle(reducedMotion ? 1 : 5);
    setState('picking');
    setHint('Pick a box! 👇');
    els.play.disabled = false;
    if (shouldRefocus) focusFirstBox();
  }

  async function pick(box) {
    if (state !== 'picking' || !round) return;
    setState('opening');
    els.play.disabled = true;
    const index = Number(box.dataset.index);
    for (const other of els.boxes.children) if (other !== box) other.classList.add('is-dim');

    setHint('Here we go…');
    box.classList.add('is-shaking');
    sound.rattle();

    try {
      const [res] = await Promise.all([
        api(`/api/rooms/${code}/rounds/${round.roundId}/pick`, { method: 'POST', body: JSON.stringify({ box: index }) }),
        wait(reducedMotion ? 200 : 950),
      ]);
      result = res;
      round = null;
    } catch (err) {
      // M1 (browser audit): `setState('idle')` below disables every box, including this one —
      // if it still holds keyboard focus, disabling it silently drops focus to <body>.
      const hadFocus = els.boxes.contains(document.activeElement);
      box.classList.remove('is-shaking');
      for (const other of els.boxes.children) other.classList.remove('is-dim');
      toast(err.message);
      round = null;
      setState('idle');
      setHint('Tap the button to play');
      els.playLabel.textContent = 'Shuffle & Play';
      els.play.disabled = false;
      refreshConfig();
      if (hadFocus) els.play.focus();
      return;
    }

    box.classList.remove('is-shaking');
    fillBox(box, result.prize, 'mine');
    box.classList.add('is-open', 'is-chosen');
    sound.pop();

    const r = box.getBoundingClientRect();
    const origin = { x: r.left + r.width / 2, y: r.top + r.height * 0.3 };
    if (result.prize.winning) {
      burst({ ...origin, count: 180, colors: [result.prize.color] });
      setHint(`🎉 ${result.prize.name}!`);
    } else {
      burst({ ...origin, count: 30, colors: ['#94a3b8'], spread: 0.5 });
      setHint(result.prize.name);
    }
    renderPlaysLeft(result.playsLeft);

    await wait(reducedMotion ? 200 : 1000);
    showReveal(result);
  }

  // C1 (code audit): the win modal was a plain <div> — Tab could escape straight into the
  // page behind it. `inert` (not a hand-rolled Tab-cycle) removes the rest of the page from
  // the focus order and the accessibility tree while the modal is open; native <dialog> was
  // avoided here because #confetti/#toast must stay interactive/visible above it (see the
  // "carnival light" theme pass notes).
  let preRevealFocus = null;
  function openRevealModal() {
    if (!els.reveal.hidden) return;
    preRevealFocus = document.activeElement;
    if (els.main) els.main.inert = true;
    els.sound.inert = true;
    els.reveal.hidden = false;
  }
  function closeRevealModal() {
    if (els.reveal.hidden) return false;
    els.reveal.hidden = true;
    if (els.main) els.main.inert = false;
    els.sound.inert = false;
    return true;
  }

  function showReveal(res) {
    const { prize, code } = res;
    els.revealCard.style.setProperty('--prize', prize.color);
    els.revealKicker.textContent = prize.winning ? '🎉 You won 🎉' : 'So close!';
    els.revealArt.replaceChildren(prizeArt(prize));
    els.revealArt.classList.toggle('no-border', noBorder(prize));
    els.revealTitle.textContent = prize.name;
    els.revealDesc.textContent = prize.description || '';
    els.revealDesc.hidden = !prize.description;
    els.revealClaim.hidden = !code;
    els.claimCode.textContent = code || '';
    // Mi3 (code audit): the button's own text content (the code) wins over `title` when
    // computing its accessible name, so a screen reader read out only the digits with no verb.
    if (code) els.claimCode.setAttribute('aria-label', `Copy claim code ${code}`);
    openRevealModal();
    els.revealClose.focus();

    if (prize.winning) {
      sound.win();
      burst({ x: innerWidth / 2, y: innerHeight * 0.35, count: 220, colors: [prize.color] });
      if (!reducedMotion) rain(2400, [prize.color]);
    } else {
      sound.aww();
    }
  }

  async function closeReveal() {
    if (!closeRevealModal()) return;
    setState('revealed');
    const chosen = els.boxes.querySelector('.is-chosen');
    const others = [...els.boxes.children].filter((b) => b !== chosen);

    setHint('Here’s what was in the other boxes');
    for (const box of others) {
      const prize = result.boxes[Number(box.dataset.index)];
      box.classList.remove('is-dim');
      if (!prize) continue;
      fillBox(box, prize);
      box.classList.add('is-open', 'is-other');
      sound.tick();
      await wait(reducedMotion ? 30 : 220);
    }

    const canPlay = result.playsLeft !== 0;
    els.playLabel.textContent = canPlay ? 'Play again' : 'No plays left';
    els.play.disabled = !canPlay;
    // Return focus somewhere sensible now that the modal (and its close button) is gone —
    // Play when it's usable, otherwise the "no plays left" message so a keyboard/screen-reader
    // user still lands somewhere meaningful instead of at <body>.
    if (canPlay) els.play.focus();
    else if (preRevealFocus && preRevealFocus.isConnected && preRevealFocus !== els.revealClose) preRevealFocus.focus();
    else els.playsLeft.focus();
  }

  // ---------- setup ----------

  async function refreshConfig() {
    try {
      config = await api(`/api/rooms/${code}/config`);
      window.Boxes.setStyle(els.boxes, config.boxStyle);
      layout();
      renderLineup(config.prizes);
      renderPlaysLeft(config.playsLeft);
      if (config.playsLeft === 0) {
        els.play.disabled = true;
        els.playLabel.textContent = 'No plays left';
      }
    } catch (err) {
      // The room disappeared (closed) or turned out to be a managed/hosted room mid-session —
      // drop to the same friendly dead-end as a failed boot rather than leaving a stale board
      // the player can no longer actually play.
      if (err.status === 404 || err.status === 409) {
        showFriendlyState(err.message, err.status === 404 ? 'Room not found' : 'This room has ended');
      }
      /* any other error (network hiccup, 429): keep the current view */
    }
  }

  async function init() {
    startStars($('stars'));

    els.sound.setAttribute('aria-pressed', String(!sound.muted));
    els.sound.addEventListener('click', () => {
      sound.muted = !sound.muted;
      els.sound.setAttribute('aria-pressed', String(!sound.muted));
      if (!sound.muted) sound.pop();
    });

    els.play.addEventListener('click', () => (state === 'picking' ? reshuffle() : play()));
    els.revealClose.addEventListener('click', closeReveal);
    document.querySelector('.reveal-backdrop').addEventListener('click', closeReveal);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeReveal(); return; }
      // `inert` on the rest of the page (see openRevealModal) already stops Tab from reaching
      // background content; this wrap-around is the other half of a real focus trap — Tab
      // from the last focusable element cycles back to the first instead of leaving the
      // document for browser chrome.
      if (e.key === 'Tab' && !els.reveal.hidden) trapTab(e, els.reveal);
    });
    els.claimCode.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(els.claimCode.textContent);
        toast('Claim code copied!');
      } catch {
        toast('Copy failed — please write the code down.');
      }
    });

    let resizeTimer;
    addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 100); });

    if (!/^\d{6}$/.test(code)) {
      showFriendlyState('This link is missing a valid 6-digit room code.', 'Missing room code');
      return;
    }

    try {
      config = await api(`/api/rooms/${code}/config`);
    } catch (err) {
      // 404 room not found, 409 ended or "hosted live — join it with your name", 429 rate
      // limited — all shown as the same friendly dead-end with a link back to "/".
      const title = err.status === 404 ? 'Room not found'
        : err.status === 409 ? 'Can’t play this room'
        : err.status === 429 ? 'Too many attempts'
        : 'Could not load the game';
      showFriendlyState(err.message, title);
      return;
    }

    document.title = config.title;
    els.title.textContent = config.title;
    els.subtitle.textContent = config.subtitle;
    window.Boxes.setStyle(els.boxes, config.boxStyle);
    renderLineup(config.prizes);
    renderPlaysLeft(config.playsLeft);
    renderBoxes(config.boxCount);
    setState('idle');

    if (config.playsLeft === 0) {
      setHint('Thanks for playing!');
      els.playLabel.textContent = 'No plays left';
      els.play.disabled = true;
    } else {
      setHint(`${config.boxCount} boxes. One is yours.`);
      els.play.disabled = false;
    }
  }

  init();
})();
