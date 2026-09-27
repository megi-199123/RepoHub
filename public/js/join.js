(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    form: $('join-form'),
    otp: [...document.querySelectorAll('.otp-digit')],
    name: $('join-name'),
    error: $('join-error'),
    btn: $('join-btn'),
    btnLabel: $('join-btn-label'),
    toast: $('toast'),
  };

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

  function showError(message) {
    els.error.textContent = message;
    els.error.hidden = false;
  }

  function clearError() {
    els.error.hidden = true;
  }

  // ---------- OTP input ----------

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

  // ---------- submit ----------

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    const code = currentCode();
    const name = els.name.value.trim();
    if (!/^\d{6}$/.test(code)) {
      showError('Enter the 6-digit room code.');
      focusIndex(code.length);
      return;
    }
    if (!name) {
      showError('Enter your name.');
      els.name.focus();
      return;
    }

    els.btn.disabled = true;
    els.btnLabel.textContent = 'Joining…';
    try {
      await api('/api/rooms/join', { method: 'POST', body: JSON.stringify({ code, name }) });
      location.href = `/room?code=${code}`;
    } catch (err) {
      showError(err.message);
      toast(err.message);
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
      if (prefill.length === 6) els.name.focus();
    } else {
      focusIndex(0);
    }
  }

  init();
})();
