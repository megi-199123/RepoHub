(function () {
  'use strict';

  const { burst, sound, startStars, reducedMotion } = window.FX;

  const $ = (id) => document.getElementById(id);
  const els = {
    roomTitle: $('room-title'),
    roomCode: $('room-code'),
    roomMe: $('room-me'),
    roomMeAvatar: $('room-me-avatar'),
    roomMeName: $('room-me-name'),
    roomMeRole: $('room-me-role'),
    statusBanner: $('status-banner'),
    statusText: $('status-text'),
    countdownPill: $('countdown-pill'),
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
  let skewMs = 0;

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

  const socket = io({ transports: ['websocket', 'polling'] });

  const board = window.Board.create(els.boxes, {
    interactive: true,
    showHands: true,
    getSelfId: () => (latestView && latestView.me ? latestView.me.id : null),
    onPick: (box) => socket.emit('game:action', { type: 'lock', box }, ackHandler),
    onUnpick: () => socket.emit('game:action', { type: 'unlock' }, ackHandler),
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

  socket.on('connect', () => { if (!ended) joinRoom(); });
  socket.on('room:state', handleState);
  socket.on('cursor', (msg) => board.handCursor(msg));
  socket.on('cursor:hide', (msg) => board.hideCursor(msg.playerId));
  socket.on('room:kicked', () => {
    ended = true;
    socket.disconnect();
    els.kickedScreen.hidden = false;
  });
  socket.on('room:closed', () => {
    ended = true;
    socket.disconnect();
    els.closedScreen.hidden = false;
  });

  function handleState(view) {
    const isFirst = !receivedFirstState;
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

  function renderStatus(view) {
    const isSpectator = view.me && view.me.role === 'spectator';
    els.statusBanner.classList.toggle('spectator', Boolean(isSpectator));
    let text = STATUS_TEXT[view.status] || '';
    if (isSpectator) text = `You're watching. ${text}`;
    els.statusText.textContent = text.trim();
  }

  function renderPlayers(view) {
    els.playerList.replaceChildren(
      ...view.players.map((p) => {
        const li = document.createElement('li');
        li.className = `player-chip${p.connected ? ' is-connected' : ''}${view.me && p.id === view.me.id ? ' is-self' : ''}`;
        li.style.setProperty('--chip-color', p.color);
        const spectatorTag = p.role === 'spectator' ? '<span class="player-chip-spectator">watching</span>' : '';
        li.innerHTML = `<span class="player-chip-avatar">${esc(p.avatar)}</span><span class="player-chip-dot" aria-hidden="true"></span><span>${esc(p.name)}</span>${spectatorTag}`;
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
    else setTimeout(() => openClaimModal(prize, claimCode, false), reducedMotion ? 200 : 1000);
  }

  function openClaimModal(prize, claimCodeValue, silent) {
    els.revealCard.style.setProperty('--prize', (prize && prize.color) || '#8b5cf6');
    els.revealKicker.textContent = '🎉 You won 🎉';
    els.revealArt.replaceChildren(prizeArt(prize));
    els.revealTitle.textContent = prize ? prize.name : 'Out of stock';
    els.revealDesc.textContent = (prize && prize.description) || '';
    els.revealDesc.hidden = !(prize && prize.description);
    els.revealClaim.hidden = false;
    els.claimCode.textContent = claimCodeValue;
    els.reveal.hidden = false;
    els.revealClose.focus();

    if (!silent) {
      sound.win();
      burst({ x: innerWidth / 2, y: innerHeight * 0.35, count: 220, colors: [(prize && prize.color) || '#fde68a'] });
    }
  }

  function closeClaim() {
    els.reveal.hidden = true;
  }

  // ---------- countdown ----------

  function tickCountdown() {
    if (!latestView || !latestView.countdownEndsAt || latestView.status !== 'picking') {
      els.countdownPill.hidden = true;
      return;
    }
    const remaining = new Date(latestView.countdownEndsAt).getTime() - (Date.now() + skewMs);
    if (remaining <= 0) {
      els.countdownPill.hidden = true;
      return;
    }
    els.countdownPill.hidden = false;
    els.countdownPill.textContent = `⏱ ${Math.ceil(remaining / 1000)}s`;
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
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !els.reveal.hidden) closeClaim(); });
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
