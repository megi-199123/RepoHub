(function () {
  'use strict';

  // Pinned by the server (server/rooms/constants.js) — keep in sync.
  const STYLES = ['gift', 'card', 'suitcase', 'chest', 'egg'];

  // "Carnival light" gift-wrap family: coral / teal / sunny-yellow, cycled light-to-deep
  // so adjacent boxes on the board stay easy to tell apart on a cream/white board.
  const BOX_COLORS = [
    ['#ff8a75', '#c2321f'], // coral
    ['#37cfc0', '#0e7a70'], // teal
    ['#ffd966', '#e8a400'], // sunny yellow
    ['#ff6b5b', '#9c2415'], // deep coral
    ['#59d6c7', '#0b5f58'], // deep teal
    ['#ffc93c', '#c77800'], // gold
    ['#ff9e8a', '#b9291a'], // coral light
    ['#7fe3d6', '#127268'], // teal light
  ];

  // Extra markup rendered inside .box-body / .box-lid, one entry per display
  // style. Anything missing from a map just renders no extra decoration.
  const BODY_DECOR = {};

  const LID_DECOR = {
    gift: '<div class="bow"><span class="bow-knot"></span></div>',
    card: '<span class="card-emblem"></span><span class="card-corner card-corner-tl"></span><span class="card-corner card-corner-br"></span>',
    suitcase: '<span class="suitcase-handle"></span><span class="suitcase-latch suitcase-latch-a"></span><span class="suitcase-latch suitcase-latch-b"></span>',
    chest: '<span class="chest-band chest-band-a"></span><span class="chest-band chest-band-b"></span><span class="chest-lock"></span>',
    egg: '',
  };

  // Width-to-height ratio each style's `.box` renders at (must match the
  // `aspect-ratio` set in app.css for that style; chest/egg don't override it,
  // so they share gift's). Callers (app.js/board.js `layout()`) use this to
  // compensate box-size for styles taller than gift, e.g. card.
  const ASPECT = {
    gift: 1 / 1.05,
    card: 0.7,
    suitcase: 1.25,
    chest: 1 / 1.05,
    egg: 1 / 1.05,
  };

  /** The width/height ratio `.box` renders at for `style` (falls back to gift's). */
  function aspect(style) {
    return ASPECT[style] || ASPECT.gift;
  }

  /** Build one box button. `style` picks the display skin (defaults to 'gift'). */
  function createBox(i, style) {
    const s = STYLES.includes(style) ? style : 'gift';
    const [c1, c2] = BOX_COLORS[i % BOX_COLORS.length];
    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'box';
    box.dataset.index = i;
    box.setAttribute('aria-label', `Open box ${i + 1}`);
    box.style.setProperty('--i', i);
    box.style.setProperty('--c1', c1);
    box.style.setProperty('--c2', c2);
    box.innerHTML = `
      <div class="box-inner">
        <div class="box-shadow"></div>
        <div class="box-glow"></div>
        <div class="box-body">${BODY_DECOR[s] || ''}</div>
        <div class="box-prize"></div>
        <div class="box-lid">${LID_DECOR[s] || ''}</div>
        <span class="box-number">${i + 1}</span>
      </div>
      <span class="box-label"></span>`;
    box.addEventListener('animationend', (e) => {
      if (e.animationName === 'box-in') box.style.animation = 'none';
    });
    return box;
  }

  /**
   * Apply a display style to a board element (its boxes are styled via `[data-style]` CSS).
   * Re-decorates any boxes already inside `boardEl` so a style change while boxes are on
   * screen (e.g. an admin edit reflected through `refreshConfig`) doesn't leave stale
   * decoration (a bow on a chest, no bands, etc). `.box-prize` is a sibling of `.box-body`/
   * `.box-lid`, so it is untouched.
   */
  function setStyle(boardEl, style) {
    const s = STYLES.includes(style) ? style : 'gift';
    if (boardEl.dataset.style === s) return;
    boardEl.dataset.style = s;
    for (const box of boardEl.children) {
      const body = box.querySelector('.box-body');
      const lid = box.querySelector('.box-lid');
      if (body) body.innerHTML = BODY_DECOR[s] || '';
      if (lid) lid.innerHTML = LID_DECOR[s] || '';
    }
  }

  window.Boxes = { STYLES, createBox, setStyle, aspect };
})();
