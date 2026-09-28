/* Landing page ("/"): 6-digit room code entry, reusing the old /join OTP UI and room.css
 * styling. Step 1 looks the code up (POST /api/rooms/lookup) — a default room goes straight
 * to /play; a managed room reveals a name field, then POST /api/rooms/join sends the player
 * to /room. See the frozen contract's "Pages (web)" section for the full flow.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    form: $('landing-form'),
    lede: $('landing-lede'),
    codeStep: $('code-step'),
    nameStep: $('name-step'),
    otp: [...document.querySelectorAll('.otp-digit')],
    foundTitle: $('found-title'),
    changeCode: $('change-code'),
    name: $('join-name'),
    watchLink: $('watch-link'),
    watchInsteadBtn: $('watch-instead-btn'),
    error: $('landing-error'),
    btn: $('landing-btn'),
    btnLabel: $('landing-btn-label'),
  };

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    const data = res.status === 204 ? null : await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error || 'Something went wrong. Please try again.');
      err.status = res.status;
      // Addendum A2: seats full, or the game is already revealing/finished — the server still
      // lets a visitor watch. Carried separately from the message so the caller can offer it.
      err.canWatch = Boolean(data?.canWatch);
      throw err;
    }
    return data;
  }

  function showError(message) {
    els.error.textContent = message;
    els.error.hidden = false;
  }

  function clearError() {
    els.error.hidden = true;
  }

  // ---------- OTP input (same pattern as the old /join page) ----------

  function focusIndex(i) {
    const el = els.otp[Math.max(0, Math.min(els.otp.length - 1, i))];
    el.focus();
    el.select();
  }

  /** Distribute a run of digits starting at `from` across the boxes (covers both a manual
   *  paste and a platform autofill, which some browsers deliver through the `input` event on a
   *  single box rather than a paste event). */
  function distribute(digits, from) {
    let i = from;
    for (const d of digits) {
      if (!els.otp[i]) break;
      els.otp[i].value = d;
      i++;
    }
    focusIndex(Math.min(i, els.otp.length - 1));
  }

  els.otp.forEach((input, i) => {
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '').split('');
      if (digits.length > 1) {
        distribute(digits, i);
      } else {
        input.value = digits[0] || '';
        if (input.value && i < els.otp.length - 1) focusIndex(i + 1);
      }
      clearError();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && i > 0) {
        e.preventDefault();
        focusIndex(i - 1);
        els.otp[i - 1].value = '';
      } else if (e.key === 'ArrowLeft' && i > 0) {
        e.preventDefault();
        focusIndex(i - 1);
      } else if (e.key === 'ArrowRight' && i < els.otp.length - 1) {
        e.preventDefault();
        focusIndex(i + 1);
      }
    });
    input.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      const digits = (text.match(/\d/g) || []).slice(0, els.otp.length - i);
      if (digits.length) {
        e.preventDefault();
        distribute(digits, i);
        clearError();
      }
    });
  });

  function currentCode() {
    return els.otp.map((i) => i.value).join('');
  }

  // ---------- step switching ----------

  let step = 'code'; // 'code' | 'name'
  let confirmedCode = '';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function hideWatchInstead() {
    els.watchInsteadBtn.hidden = true;
  }

  function showNameStep(room) {
    step = 'name';
    confirmedCode = room.code;
    els.foundTitle.innerHTML = `${esc(room.title)} <span class="muted">· Code ${esc(room.code)}</span>`;
    els.codeStep.hidden = true;
    els.nameStep.hidden = false;
    els.watchLink.href = `/watch?code=${room.code}`;
    hideWatchInstead();
    els.lede.textContent = 'This room is hosted live — enter your name to join.';
    els.btnLabel.textContent = 'Join room';
    clearError();
    els.name.focus();
  }

  function showCodeStep() {
    step = 'code';
    confirmedCode = '';
    els.nameStep.hidden = true;
    els.codeStep.hidden = false;
    hideWatchInstead();
    els.lede.textContent = 'Enter the 6-digit room code to play.';
    els.btnLabel.textContent = 'Continue';
    clearError();
    focusIndex(0);
  }

  els.changeCode.addEventListener('click', showCodeStep);
  els.watchInsteadBtn.addEventListener('click', () => { location.href = els.watchLink.href; });

  // ---------- submit ----------

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    if (step === 'code') {
      const code = currentCode();
      if (!/^\d{6}$/.test(code)) {
        showError('Enter the 6-digit room code.');
        focusIndex(code.length);
        return;
      }
      els.btn.disabled = true;
      els.btnLabel.textContent = 'Checking…';
      try {
        const room = await api('/api/rooms/lookup', { method: 'POST', body: JSON.stringify({ code }) });
        if (room.type === 'default') {
          location.href = `/play?code=${room.code}`;
          return; // keep the button disabled through the navigation
        }
        showNameStep(room);
      } catch (err) {
        showError(err.message);
      }
      els.btn.disabled = false;
      els.btnLabel.textContent = step === 'code' ? 'Continue' : 'Join room';
      return;
    }

    // step === 'name'
    const name = els.name.value.trim();
    if (!name) {
      showError('Enter your name.');
      els.name.focus();
      return;
    }
    hideWatchInstead();
    els.btn.disabled = true;
    els.btnLabel.textContent = 'Joining…';
    try {
      const res = await api('/api/rooms/join', { method: 'POST', body: JSON.stringify({ code: confirmedCode, name }) });
      location.href = res.type === 'default' ? `/play?code=${res.code}` : `/room?code=${res.code}`;
    } catch (err) {
      showError(err.message);
      // Addendum A2: seats full, or the game is already revealing/finished — offer a one-tap
      // way to watch instead of leaving the player stuck on a hard error.
      if (err.canWatch) els.watchInsteadBtn.hidden = false;
      els.btn.disabled = false;
      els.btnLabel.textContent = 'Join room';
    }
  });

  // ---------- setup ----------

  function init() {
    if (window.FX) window.FX.startStars($('stars'));

    const params = new URLSearchParams(location.search);
    const prefill = (params.get('code') || '').replace(/\D/g, '').slice(0, 6);
    if (prefill) {
      distribute(prefill.split(''), 0);
      // /?code=123456 pre-fills AND auto-looks-up.
      if (prefill.length === 6) els.form.requestSubmit();
    } else {
      focusIndex(0);
    }
  }

  init();
})();
