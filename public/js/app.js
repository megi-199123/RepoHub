(function () {
  'use strict';

  const { burst, rain, sound, startStars, reducedMotion } = window.FX;

  const $ = (id) => document.getElementById(id);
  const els = {
    title: $('title'),
    subtitle: $('subtitle'),
    lineup: $('lineup'),
    lineupList: $('lineup-list'),
    hint: $('hint'),
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

  const BOX_COLORS = [
    ['#a78bfa', '#6d28d9'],
    ['#f472b6', '#be185d'],
    ['#38bdf8', '#0369a1'],
    ['#34d399', '#047857'],
    ['#fb923c', '#c2410c'],
    ['#f87171', '#b91c1c'],
    ['#818cf8', '#4338ca'],
    ['#2dd4bf', '#0f766e'],
  ];

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
    if (!res.ok) throw new Error(data?.error || 'Something went wrong. Please try again.');
    return data;
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
        art.className = 'lineup-art';
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
    const [c1, c2] = BOX_COLORS[i % BOX_COLORS.length];
    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'box';
    box.style.setProperty('--i', i);
    box.style.setProperty('--c1', c1);
    box.style.setProperty('--c2', c2);
    box.innerHTML = `
      <div class="box-inner">
        <div class="box-shadow"></div>
        <div class="box-glow"></div>
        <div class="box-body"></div>
        <div class="box-prize"></div>
        <div class="box-lid"><div class="bow"><span class="bow-knot"></span></div></div>
        <span class="box-number"></span>
      </div>
      <span class="box-label"></span>`;
    box.addEventListener('animationend', (e) => {
      if (e.animationName === 'box-in') box.style.animation = 'none';
    });
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
    const size = Math.max(96, Math.min(190, sizeFor(cols)));
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

  function fillBox(box, prize) {
    const slot = box.querySelector('.box-prize');
    slot.replaceChildren(prizeArt(prize));
    box.querySelector('.box-label').textContent = prize.name;
    box.style.setProperty('--prize', prize.color);
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
    els.play.disabled = true;
    setState('shuffling');
    setHint('Shuffling the boxes…');

    try {
      await closeAllBoxes();
      const [newRound] = await Promise.all([
        api('/api/rounds', { method: 'POST' }),
        shuffle(reducedMotion ? 1 : 7),
      ]);
      round = newRound;
      // The backoffice may have changed the box count since the page loaded.
      if (round.boxCount !== els.boxes.children.length) renderBoxes(round.boxCount);
      setState('picking');
      setHint('Pick a box! 👇');
      els.playLabel.textContent = 'Shuffle again';
      els.play.disabled = false;
    } catch (err) {
      toast(err.message);
      setState('idle');
      setHint('Tap the button to try again');
      els.play.disabled = false;
      refreshConfig();
    }
  }

  async function reshuffle() {
    // Allow reshuffling while picking — same round, just a fresh visual shuffle.
    els.play.disabled = true;
    setState('shuffling');
    setHint('Shuffling again…');
    await shuffle(reducedMotion ? 1 : 5);
    setState('picking');
    setHint('Pick a box! 👇');
    els.play.disabled = false;
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
        api(`/api/rounds/${round.roundId}/pick`, { method: 'POST', body: JSON.stringify({ box: index }) }),
        wait(reducedMotion ? 200 : 950),
      ]);
      result = res;
      round = null;
    } catch (err) {
      box.classList.remove('is-shaking');
      for (const other of els.boxes.children) other.classList.remove('is-dim');
      toast(err.message);
      round = null;
      setState('idle');
      setHint('Tap the button to play');
      els.playLabel.textContent = 'Shuffle & Play';
      els.play.disabled = false;
      refreshConfig();
      return;
    }

    box.classList.remove('is-shaking');
    fillBox(box, result.prize);
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

  function showReveal(res) {
    const { prize, code } = res;
    els.revealCard.style.setProperty('--prize', prize.color);
    els.revealKicker.textContent = prize.winning ? '🎉 You won 🎉' : 'So close!';
    els.revealArt.replaceChildren(prizeArt(prize));
    els.revealTitle.textContent = prize.name;
    els.revealDesc.textContent = prize.description || '';
    els.revealDesc.hidden = !prize.description;
    els.revealClaim.hidden = !code;
    els.claimCode.textContent = code || '';
    els.reveal.hidden = false;
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
    if (els.reveal.hidden) return;
    els.reveal.hidden = true;
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
    if (canPlay) els.play.focus();
  }

  // ---------- setup ----------

  async function refreshConfig() {
    try {
      config = await api('/api/config');
      renderLineup(config.prizes);
      renderPlaysLeft(config.playsLeft);
      if (config.playsLeft === 0) {
        els.play.disabled = true;
        els.playLabel.textContent = 'No plays left';
      }
    } catch { /* keep the current view */ }
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
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReveal(); });
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

    try {
      config = await api('/api/config');
    } catch (err) {
      setHint('Could not load the game. Please refresh.');
      toast(err.message);
      return;
    }

    document.title = config.title;
    els.title.textContent = config.title;
    els.subtitle.textContent = config.subtitle;
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
