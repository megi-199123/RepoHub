(function () {
  'use strict';

  const { burst, sound, startStars, reducedMotion } = window.FX;

  const $ = (id) => document.getElementById(id);
  const els = {
    main: document.querySelector('main.room-app'),
    roomTitle: $('room-title'),
    roomCode: $('room-code'),
    roomMe: $('room-me'),
    roomMeAvatar: $('room-me-avatar'),
    roomMeName: $('room-me-name'),
    roomMeRole: $('room-me-role'),
    reconnectBanner: $('reconnect-banner'),
    statusBanner: $('status-banner'),
    statusText: $('status-text'),
    countdownPill: $('countdown-pill'),
    srAnnounce: $('sr-announce'),
    playerList: $('player-list'),
    boxes: $('boxes'),
    resultsList: $('results-list'),
    reveal: $('reveal'),
    revealCard: document.querySelector('.reveal-card'),
    revealKicker: $('reveal-kicker'),
    revealArt: $('reveal-art'),
    revealTitle: $('reveal-title'),
    revealDesc: $('reveal-desc'),
    revealClaim: $('reveal-claim'),
    claimCode: $('claim-code'),
    revealClose: $('reveal-close'),
    kickedScreen: $('kicked-screen'),
    closedScreen: $('closed-screen'),
    toast: $('toast'),
    sound: $('sound-toggle'),
  };

  const STATUS_TEXT = {
    lobby: 'Waiting for the host…',
    picking: 'Pick a box and lock it in!',
    locked: "Time's up!",
    revealing: 'Revealing the boxes…',
    finished: 'That’s everyone — check your box!',
    closed: 'This room has ended.',
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

  const params = new URLSearchParams(location.search);
  const code = (params.get('code') || '').trim();
  if (!/^\d{6}$/.test(code)) {
    location.href = '/join';
    return;
  }

  let latestView = null;
  let receivedFirstState = false;
  let ended = false;
  let lastClaimCode = null;
  let claimOpenTimer = null;
  let skewMs = 0;
  let socketConnected = false;
  let awaitingRejoinBanner = false;
  // N6 (code audit): `socketConnected` alone flips true the instant the transport reconnects —
  // before this connection's re-emitted `room:join` has landed server-side and before the
  // fresh `room:state` for it arrives. A pick/release fired in that window used to reach the
  // server while `socket.data.roomId` was still null, coming back as a confusing "Only players
  // can act" toast instead of "still reconnecting". `rejoined` stays false across that gap.
  let rejoined = false;

  let toastTimer;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3200);
  }

  function ackHandler(res) {
    if (res && res.ok === false) toast(res.error);
  }

  // B.4: visible connection feedback. `awaitingRejoinBanner` keeps the banner up across the
  // gap between the transport reconnecting and this client's `room:join` actually landing —
  // clearing on `connect` alone would show "back online" a beat before room:state confirms it.
  function showReconnectBanner(text) {
    if (!text) { els.reconnectBanner.hidden = true; return; }
    els.reconnectBanner.textContent = text;
    els.reconnectBanner.hidden = false;
  }

  const socket = io({ transports: ['websocket', 'polling'] });

  const board = window.Board.create(els.boxes, {
    interactive: true,
    showHands: true,
    getSelfId: () => (latestView && latestView.me ? latestView.me.id : null),
    // B.4: Socket.IO buffers emits made while disconnected and replays them once reconnected —
    // silently, with no feedback at the time — so block picks/releases until we're actually
    // back and rejoined rather than letting a lock request queue up invisibly.
    onPick: (box) => {
      if (!socketConnected || !rejoined) return toast("Reconnecting — please wait a moment and try again.");
      socket.emit('game:action', { type: 'lock', box }, ackHandler);
    },
    onUnpick: () => {
      if (!socketConnected || !rejoined) return toast("Reconnecting — please wait a moment and try again.");
      socket.emit('game:action', { type: 'unlock' }, ackHandler);
    },
    onTaken: (name) => toast(`Taken by ${name}`),
    onCursor: (msg) => socket.emit('cursor:move', msg),
    onCursorHide: () => socket.emit('cursor:hide', {}),
  });

  function joinRoom() {
    socket.emit('room:join', { code }, (res) => {
      if (ended) return;
      if (!res || !res.ok) {
        ended = true;
        location.href = `/join?code=${code}`;
      }
    });
  }

  socket.on('connect', () => {
    socketConnected = true;
    if (!ended) joinRoom();
  });
  socket.on('room:state', handleState);
  socket.on('cursor', (msg) => board.handCursor(msg));
  socket.on('cursor:hide', (msg) => board.hideCursor(msg.playerId));
  // N1 (code audit): these used to leave the reveal/claim modal's `inert` trap engaged forever
  // if it happened to be open at the moment of a kick/close — Tab would keep cycling between
  // its (now covered-up) buttons and could never reach "Join another room". Close it first,
  // on every takeover path, same as Escape already does.
  socket.on('room:kicked', () => {
    ended = true;
    socket.disconnect();
    showTakeover(els.kickedScreen);
  });
  socket.on('room:closed', () => {
    ended = true;
    socket.disconnect();
    showTakeover(els.closedScreen);
  });
  socket.on('disconnect', (reason) => {
    socketConnected = false;
    rejoined = false;
    if (ended) return;
    awaitingRejoinBanner = true;
    showReconnectBanner('Connection lost — reconnecting…');
    // This one disconnect reason is Socket.IO telling us it will NOT auto-reconnect on its own.
    if (reason === 'io server disconnect') socket.connect();
  });
  socket.on('connect_error', () => {
    if (ended) return;
    awaitingRejoinBanner = true;
    showReconnectBanner('Connection problem — retrying…');
  });
  socket.io.on('reconnect_attempt', () => {
    if (!ended) showReconnectBanner('Reconnecting…');
  });
  socket.io.on('reconnect_failed', () => {
    if (!ended) showReconnectBanner('Unable to reconnect. Please refresh the page.');
  });

  function handleState(view) {
    const isFirst = !receivedFirstState;
    rejoined = true;
    if (awaitingRejoinBanner) { awaitingRejoinBanner = false; showReconnectBanner(null); }
    skewMs = new Date(view.serverNow).getTime() - Date.now();
    latestView = view;
    board.render(view);
    renderHeader(view);
    renderStatus(view);
    renderPlayers(view);
    renderResults(view);
    renderClaim(view, isFirst);
    receivedFirstState = true;
  }

  function renderHeader(view) {
    document.title = `${view.title} — Room ${view.code}`;
    els.roomTitle.textContent = view.title;
    els.roomCode.textContent = view.code;
    const me = view.me && view.me.id ? view.players.find((p) => p.id === view.me.id) : null;
    if (me) {
      els.roomMe.hidden = false;
      els.roomMe.style.setProperty('--me-color', me.color);
      els.roomMeAvatar.textContent = me.avatar;
      els.roomMeName.textContent = me.name;
      els.roomMeRole.textContent = me.role;
    } else {
      els.roomMe.hidden = true;
    }
  }

  let lastStatusText = null;
  function renderStatus(view) {
    const isSpectator = view.me && view.me.role === 'spectator';
    els.statusBanner.classList.toggle('spectator', Boolean(isSpectator));
    let text = STATUS_TEXT[view.status] || '';
    if (isSpectator) text = `You're watching. ${text}`;
    text = text.trim();
    // C2 (code audit): `room:state` (and this call) fires on every lock/pick, not just on a
    // real status change — writing unconditionally into this aria-live region re-announced
    // the same sentence to screen readers on every other player's move.
    if (text !== lastStatusText) {
      lastStatusText = text;
      els.statusText.textContent = text;
    }
  }

  function renderPlayers(view) {
    els.playerList.replaceChildren(
      ...view.players.map((p) => {
        const li = document.createElement('li');
        li.className = `player-chip${p.connected ? ' is-connected' : ''}${view.me && p.id === view.me.id ? ' is-self' : ''}`;
        li.style.setProperty('--chip-color', p.color);
        const spectatorTag = p.role === 'spectator' ? '<span class="player-chip-spectator">watching</span>' : '';
        // NF-5 (round-2 audit): the dot alone was color-only AND aria-hidden — a screen-reader
        // user had no way to know who's connected. The dot stays decorative (its shape now also
        // differs, hollow vs filled — see room.css) and this sr-only text carries the meaning.
        li.innerHTML = `<span class="player-chip-avatar">${esc(p.avatar)}</span><span class="player-chip-dot" aria-hidden="true"></span><span class="sr-only">${p.connected ? 'Online' : 'Away'}</span><span>${esc(p.name)}</span>${spectatorTag}`;
        return li;
      }),
    );
  }

  function renderResults(view) {
    const show = view.status === 'revealing' || view.status === 'finished';
    els.resultsList.hidden = !show;
    if (!show) return;
    const playersById = new Map(view.players.map((p) => [p.id, p]));
    const rows = view.boxes.filter((b) => b.revealed && b.playerId).sort((a, b) => a.box - b.box);
    els.resultsList.replaceChildren(
      ...rows.map((b) => {
        const owner = playersById.get(b.playerId);
        const li = document.createElement('li');
        li.className = `result-row${view.me && b.playerId === view.me.id ? ' is-self' : ''}`;
        if (owner) li.style.setProperty('--row-color', owner.color);
        const prizeName = b.prize ? b.prize.name : 'Out of stock';
        const emoji = b.prize ? b.prize.emoji || '🎁' : '❔';
        li.innerHTML = `<span class="result-avatar">${esc(owner ? owner.avatar : '🙂')}</span><span class="result-name">${esc(owner ? owner.name : 'Someone')}</span><span class="result-emoji">${esc(emoji)}</span><span class="result-prize">${esc(prizeName)}</span>`;
        return li;
      }),
    );
  }

  function renderClaim(view, isFirst) {
    const claimCode = view.me && view.me.claimCode;
    if (!claimCode) {
      lastClaimCode = null;
      return;
    }
    if (claimCode === lastClaimCode) return;
    lastClaimCode = claimCode;

    const myBox = view.boxes.find((b) => b.playerId === view.me.id && b.revealed);
    const prize = myBox ? myBox.prize : null;
    if (isFirst) openClaimModal(prize, claimCode, true);
    // N (code review): keep the timer id so a room:closed/kicked landing inside this delay can
    // cancel it in showTakeover() below — otherwise the modal could still pop open under an
    // already-shown takeover and trap Tab focus away from "Join another room".
    else claimOpenTimer = setTimeout(() => { claimOpenTimer = null; openClaimModal(prize, claimCode, false); }, reducedMotion ? 200 : 1000);
  }

  /** Cycle Tab/Shift+Tab between the first and last focusable element inside `container` —
   *  see the identical helper (and rationale) in public/js/app.js. */
  function trapTab(e, container) {
    const list = [...container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // C1 (code audit): the claim modal was a plain <div> — Tab could escape into the board
  // behind it. `inert` removes the rest of the page from the focus order and accessibility
  // tree while it's open (see the matching note in public/js/app.js's `openRevealModal`).
  let preClaimFocus = null;
  function closeClaim() {
    if (els.reveal.hidden) return;
    els.reveal.hidden = true;
    if (els.main) els.main.inert = false;
    els.sound.inert = false;
    if (preClaimFocus && preClaimFocus.isConnected && preClaimFocus !== els.revealClose) preClaimFocus.focus();
  }

  /** N1 (code audit): kicked/closed can land while the claim modal is open — always release its
   *  inert/Tab-trap first, then keep the rest of the page inert (nothing behind the takeover is
   *  meant to be reachable any more) and move focus onto the takeover card itself so a keyboard
   *  or screen-reader user lands somewhere meaningful instead of a stale, now-hidden control. */
  function showTakeover(screenEl) {
    // Cancel a still-pending "open the claim modal" timer (renderClaim's non-first-sighting
    // delay) — otherwise it can fire after this takeover is already up, popping the claim
    // modal open on top of it and trapping Tab away from "Join another room".
    if (claimOpenTimer) { clearTimeout(claimOpenTimer); claimOpenTimer = null; }
    closeClaim();
    if (els.main) els.main.inert = true;
    els.sound.inert = true;
    screenEl.hidden = false;
    const card = screenEl.querySelector('.takeover-card');
    if (card) card.focus();
  }

  function openClaimModal(prize, claimCodeValue, silent) {
    // Belt-and-braces alongside the cleared timer in showTakeover(): never open the claim
    // modal once a takeover (kicked/closed) is already up.
    if (ended) return;
    // N12 (code audit): these two fallbacks (only reachable on the rare "claimed but the prize
    // ran out of stock" path) were still the old dark-theme purple/gold — swap to the current
    // "Carnival light" palette (coral / sunny yellow).
    els.revealCard.style.setProperty('--prize', (prize && prize.color) || '#ff6b5b');
    els.revealKicker.textContent = '🎉 You won 🎉';
    els.revealArt.replaceChildren(prizeArt(prize));
    els.revealTitle.textContent = prize ? prize.name : 'Out of stock';
    els.revealDesc.textContent = (prize && prize.description) || '';
    els.revealDesc.hidden = !(prize && prize.description);
    els.revealClaim.hidden = false;
    els.claimCode.textContent = claimCodeValue;
    // Mi3 (code audit): the button's own text content (the code) wins over `title` when
    // computing its accessible name, so a screen reader read out only the digits with no verb.
    els.claimCode.setAttribute('aria-label', `Copy claim code ${claimCodeValue}`);
    if (els.reveal.hidden) {
      preClaimFocus = document.activeElement;
      if (els.main) els.main.inert = true;
      els.sound.inert = true;
    }
    els.reveal.hidden = false;
    els.revealClose.focus();

    if (!silent) {
      sound.win();
      burst({ x: innerWidth / 2, y: innerHeight * 0.35, count: 220, colors: [(prize && prize.color) || '#ffc93c'] });
    }
  }

  // ---------- countdown ----------

  // C2 (code audit): the pill used to sit inside an aria-live region and tick every second —
  // a sustained "15… 14… 13…" barrage for a screen-reader user. It's now aria-hidden in the
  // HTML (purely visual); this announces only coarse milestones through a separate sr-only
  // live region instead.
  let announcedFor = null;
  let announcedMilestones = null;
  function announce(message) {
    els.srAnnounce.textContent = '';
    // Force a DOM mutation even if the text is identical to the last announcement (e.g. a
    // second countdown that also happens to start with "Countdown started.").
    requestAnimationFrame(() => { els.srAnnounce.textContent = message; });
  }

  function tickCountdown() {
    if (!latestView || !latestView.countdownEndsAt || latestView.status !== 'picking') {
      els.countdownPill.hidden = true;
      return;
    }
    const endsAt = latestView.countdownEndsAt;
    const remaining = new Date(endsAt).getTime() - (Date.now() + skewMs);
    if (remaining <= 0) {
      els.countdownPill.hidden = true;
      // Record this endsAt as seen (silently) so a countdown that's already over by the time
      // we first observe it never announces "Countdown started." or anything else, stale.
      if (endsAt !== announcedFor) { announcedFor = endsAt; announcedMilestones = new Set([10, 5]); }
      return;
    }
    const seconds = Math.ceil(remaining / 1000);
    if (endsAt !== announcedFor) {
      announcedFor = endsAt;
      announcedMilestones = new Set();
      announce(seconds > 10 ? 'Countdown started.' : `${seconds} seconds left.`);
      // Pre-mark any milestone already behind us at first sighting so it's never re-announced
      // right after the message above (e.g. a 5s countdown shouldn't hear "started" then "5
      // seconds left" back to back — just the one, correct message).
      if (seconds <= 10) announcedMilestones.add(10);
      if (seconds <= 5) announcedMilestones.add(5);
    }
    els.countdownPill.hidden = false;
    els.countdownPill.textContent = `⏱ ${seconds}s`;
    if (seconds <= 10 && !announcedMilestones.has(10)) { announcedMilestones.add(10); announce('10 seconds left.'); }
    if (seconds <= 5 && !announcedMilestones.has(5)) { announcedMilestones.add(5); announce('5 seconds left.'); }
  }

  // ---------- setup ----------

  function init() {
    startStars($('stars'));

    els.sound.setAttribute('aria-pressed', String(!sound.muted));
    els.sound.addEventListener('click', () => {
      sound.muted = !sound.muted;
      els.sound.setAttribute('aria-pressed', String(!sound.muted));
      if (!sound.muted) sound.pop();
    });

    els.revealClose.addEventListener('click', closeClaim);
    document.querySelector('#reveal .reveal-backdrop').addEventListener('click', closeClaim);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !els.reveal.hidden) { closeClaim(); return; }
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

    setInterval(tickCountdown, 250);
  }

  init();
})();
