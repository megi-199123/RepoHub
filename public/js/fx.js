/* Visual & audio effects: twinkling starfield, confetti bursts and synthesized sounds. */
(function () {
  'use strict';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function fitCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  // ---------- starfield ----------

  // "Carnival light" confetti-dot backdrop: small drifting dots in the brand palette,
  // instead of the old dark-theme white starfield (invisible on a cream page).
  const SPECK_COLORS = ['#ff6b5b', '#ffc93c', '#1fb5a6'];

  function startStars(canvas) {
    let ctx = fitCanvas(canvas);
    let stars = [];
    const seed = () => {
      const count = Math.round((innerWidth * innerHeight) / 9000);
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * innerWidth,
        y: Math.random() * innerHeight,
        r: Math.random() * 1.4 + 0.3,
        phase: Math.random() * Math.PI * 2,
        speed: Math.random() * 0.02 + 0.005,
        drift: Math.random() * 0.15 + 0.02,
        color: SPECK_COLORS[Math.floor(Math.random() * SPECK_COLORS.length)],
      }));
    };
    seed();
    addEventListener('resize', () => { ctx = fitCanvas(canvas); seed(); });

    const draw = () => {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const s of stars) {
        s.phase += s.speed;
        s.y -= s.drift;
        if (s.y < -2) { s.y = innerHeight + 2; s.x = Math.random() * innerWidth; }
        const a = 0.22 + Math.sin(s.phase) * 0.16;
        ctx.globalAlpha = Math.max(0, a);
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (!reducedMotion) requestAnimationFrame(draw);
    };
    draw();
  }

  // ---------- confetti ----------

  const confettiCanvas = document.getElementById('confetti');
  let confettiCtx = confettiCanvas && fitCanvas(confettiCanvas);
  let pieces = [];
  let running = false;
  addEventListener('resize', () => { if (confettiCanvas) confettiCtx = fitCanvas(confettiCanvas); });

  const PALETTE = ['#ffc93c', '#e8a400', '#ff6b5b', '#c2321f', '#1fb5a6', '#0e7a70', '#2b2233'];

  function burst({ x = innerWidth / 2, y = innerHeight / 2, count = 160, colors = [], spread = 1 } = {}) {
    if (!confettiCtx) return;
    const palette = [...colors, ...PALETTE];
    if (reducedMotion) count = Math.round(count / 4);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (Math.random() * 9 + 4) * spread;
      pieces.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 7,
        w: Math.random() * 8 + 5,
        h: Math.random() * 5 + 3,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.35,
        color: palette[Math.floor(Math.random() * palette.length)],
        shape: Math.random() < 0.25 ? 'circle' : Math.random() < 0.15 ? 'star' : 'rect',
        life: 0,
        ttl: 140 + Math.random() * 90,
        wobble: Math.random() * 10,
      });
    }
    if (!running) { running = true; requestAnimationFrame(tick); }
  }

  /** Confetti raining from the top edge — used for big wins. */
  function rain(duration = 2200, colors = []) {
    const end = performance.now() + duration;
    const drop = () => {
      burst({ x: Math.random() * innerWidth, y: -20, count: 6, colors, spread: 0.4 });
      if (performance.now() < end) setTimeout(drop, 60);
    };
    drop();
  }

  function drawStar(ctx, r) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 ? r / 2.2 : r;
      const a = (i * Math.PI) / 5 - Math.PI / 2;
      ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
    }
    ctx.closePath();
    ctx.fill();
  }

  function tick() {
    const ctx = confettiCtx;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    pieces = pieces.filter((p) => p.life < p.ttl && p.y < innerHeight + 40);
    for (const p of pieces) {
      p.life++;
      p.vx *= 0.985;
      p.vy = p.vy * 0.985 + 0.22;
      p.x += p.vx + Math.sin((p.life + p.wobble) / 8) * 0.6;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.min(1, (p.ttl - p.life) / 40);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, p.h / 1.4, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.shape === 'star') {
        drawStar(ctx, p.w / 1.3);
      } else {
        ctx.scale(1, Math.cos(p.life / 6));
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    }
    if (pieces.length) requestAnimationFrame(tick);
    else { running = false; ctx.clearRect(0, 0, innerWidth, innerHeight); }
  }

  // ---------- sound ----------

  let audio = null;
  let muted = false;
  try { muted = localStorage.getItem('mb-muted') === '1'; } catch { /* storage unavailable */ }

  function ac() {
    if (muted) return null;
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      return audio;
    } catch {
      return null;
    }
  }

  function tone(freq, { at = 0, dur = 0.15, type = 'sine', vol = 0.18, slide = 0 } = {}) {
    const ctx = ac();
    if (!ctx) return;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  const sound = {
    get muted() { return muted; },
    set muted(value) {
      muted = value;
      try { localStorage.setItem('mb-muted', value ? '1' : '0'); } catch { /* ignore */ }
    },
    swoosh() { tone(260, { dur: 0.18, type: 'triangle', vol: 0.08, slide: 1.8 }); },
    tick() { tone(900 + Math.random() * 200, { dur: 0.05, type: 'square', vol: 0.03 }); },
    rattle() { for (let i = 0; i < 8; i++) tone(180 + Math.random() * 120, { at: i * 0.1, dur: 0.06, type: 'triangle', vol: 0.07 }); },
    pop() { tone(420, { dur: 0.25, type: 'sine', vol: 0.25, slide: 2.4 }); },
    win() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, { at: 0.08 + i * 0.09, dur: 0.35, type: 'triangle', vol: 0.16 }));
      [1318.5, 1568].forEach((f, i) => tone(f, { at: 0.5 + i * 0.07, dur: 0.5, type: 'sine', vol: 0.08 }));
    },
    aww() {
      tone(392, { at: 0.05, dur: 0.3, type: 'triangle', vol: 0.12 });
      tone(311.13, { at: 0.32, dur: 0.5, type: 'triangle', vol: 0.12, slide: 0.94 });
    },
  };

  window.FX = { startStars, burst, rain, sound, reducedMotion };
})();
