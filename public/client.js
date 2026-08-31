/* JumbleGrid client */
(() => {
  const $ = (sel) => document.querySelector(sel);

  const lobbyEl = $('#lobby');
  const gameEl = $('#game');
  const nameInput = $('#name-input');
  const roomInput = $('#room-input');
  const lobbyError = $('#lobby-error');
  const roomBadge = $('#room-badge');
  const roomCodeLabel = $('#room-code-label');
  const scoreboardEl = $('#scoreboard');
  const timerEl = $('#timer');
  const roundControls = $('#round-controls');
  const startBtn = $('#start-btn');
  const resultBanner = $('#result-banner');
  const gridEl = $('#grid');
  const wordForm = $('#word-form');
  const wordInput = $('#word-input');
  const clearBtn = $('#clear-btn');
  const toastEl = $('#toast');
  const wordListEl = $('#word-list');
  const wordCountEl = $('#word-count');
  const minLenHint = $('#min-len-hint');

  let room = null;        // room code
  let playerId = null;
  let state = null;       // last server state
  let path = [];          // selected tile indices (click-to-trace)
  let timerInterval = null;
  let toastTimeout = null;

  // ------------------------------------------------------------------ lobby
  const saved = JSON.parse(localStorage.getItem('jumblegrid') || '{}');
  if (saved.name) nameInput.value = saved.name;
  if (saved.room) roomInput.value = saved.room;

  $('#random-room-btn').addEventListener('click', () => {
    const animals = ['WOMBAT', 'GECKO', 'MARMOT', 'HERON', 'OTTER', 'BADGER',
      'CONDOR', 'IBEX', 'LEMUR', 'NARWHAL', 'PUFFIN', 'QUOKKA'];
    roomInput.value = animals[Math.floor(Math.random() * animals.length)] +
      Math.floor(Math.random() * 90 + 10);
  });

  $('#join-btn').addEventListener('click', join);
  [nameInput, roomInput].forEach((el) =>
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); }));

  async function join() {
    const name = nameInput.value.trim();
    const code = roomInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    lobbyError.textContent = '';
    if (!name) { lobbyError.textContent = 'Please enter a name.'; return; }
    if (!code) { lobbyError.textContent = 'Please enter a room code.'; return; }

    const prev = JSON.parse(localStorage.getItem('jumblegrid') || '{}');
    const rejoinId = prev.room === code ? prev.playerId : undefined;

    const resp = await api('/api/join', { room: code, name, playerId: rejoinId });
    if (!resp.ok) { lobbyError.textContent = resp.reason || 'Could not join.'; return; }

    room = resp.room;
    playerId = resp.playerId;
    localStorage.setItem('jumblegrid', JSON.stringify({ name, room, playerId }));

    lobbyEl.classList.add('hidden');
    gameEl.classList.remove('hidden');
    roomBadge.classList.remove('hidden');
    roomCodeLabel.textContent = room;
    connect();
  }

  // ---------------------------------------------------------------- network
  async function api(url, body) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await r.json();
    } catch (e) {
      return { ok: false, reason: 'Network error — is the server up?' };
    }
  }

  function connect() {
    const es = new EventSource(`/events?room=${encodeURIComponent(room)}`);
    es.onmessage = (e) => {
      state = JSON.parse(e.data);
      render();
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
  }

  // ---------------------------------------------------------------- actions
  startBtn.addEventListener('click', async () => {
    const size = Number(document.querySelector('input[name="size"]:checked').value);
    const resp = await api('/api/start', { room, playerId, size });
    if (!resp.ok) toast(resp.reason, false);
  });

  wordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const word = wordInput.value.trim();
    if (!word) return;
    const resp = await api('/api/word', { room, playerId, word });
    if (resp.ok) {
      toast(`+${resp.points} for ${word.toUpperCase()}!`, true);
      resetEntry();
    } else {
      toast(resp.reason, false);
    }
    wordInput.focus();
  });

  clearBtn.addEventListener('click', () => { resetEntry(); wordInput.focus(); });

  // Typing by hand invalidates any traced path.
  wordInput.addEventListener('input', () => {
    if (path.length && wordInput.value !== pathWord()) {
      path = [];
      paintPath();
    }
  });

  function resetEntry() {
    wordInput.value = '';
    path = [];
    paintPath();
  }

  async function veto(word) {
    const resp = await api('/api/veto', { room, playerId, word });
    if (!resp.ok) toast(resp.reason, false);
  }

  // ------------------------------------------------------------------ grid
  function tileClicked(idx) {
    if (!state || state.state !== 'playing') return;
    const last = path[path.length - 1];
    if (idx === last) {
      path.pop(); // tap the last tile again to undo
    } else if (path.includes(idx)) {
      return; // each die once
    } else if (path.length === 0 || isAdjacent(last, idx, state.size)) {
      path.push(idx);
    } else {
      return; // not adjacent — ignore
    }
    wordInput.value = pathWord();
    paintPath();
  }

  function isAdjacent(a, b, n) {
    const dr = Math.abs(Math.floor(a / n) - Math.floor(b / n));
    const dc = Math.abs((a % n) - (b % n));
    return dr <= 1 && dc <= 1;
  }

  function pathWord() {
    return path.map((i) => state.grid[i]).join('');
  }

  function paintPath() {
    [...gridEl.children].forEach((tile, i) => {
      tile.classList.toggle('selected', path.includes(i));
      tile.classList.toggle('head', path[path.length - 1] === i);
    });
  }

  function renderGrid() {
    gridEl.className = `grid-${state.size}`;
    gridEl.innerHTML = '';
    if (!state.grid) {
      gridEl.classList.add('empty');
      gridEl.textContent = 'Press “Start round” to roll the dice';
      return;
    }
    state.grid.forEach((cell, i) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'tile';
      tile.textContent = cell === 'qu' ? 'Qu' : cell.toUpperCase();
      tile.addEventListener('click', () => tileClicked(i));
      gridEl.appendChild(tile);
    });
    paintPath();
  }

  // ------------------------------------------------------------------ render
  let lastGridKey = null;

  function render() {
    // Scoreboard
    scoreboardEl.innerHTML = '';
    state.players
      .slice()
      .sort((a, b) => b.score - a.score)
      .forEach((p) => {
        const div = document.createElement('div');
        div.className = 'player' + (p.id === playerId ? ' me' : '');
        div.innerHTML = `<span class="pname"></span><span class="pscore">${p.score}</span>`;
        div.querySelector('.pname').textContent = p.name;
        scoreboardEl.appendChild(div);
      });

    // Grid (rebuild only when it changes, so selection survives re-renders)
    const gridKey = `${state.round}:${(state.grid || []).join(',')}`;
    if (gridKey !== lastGridKey) {
      lastGridKey = gridKey;
      path = [];
      wordInput.value = '';
      renderGrid();
    }

    // Round controls / timer / input
    const playing = state.state === 'playing';
    wordForm.classList.toggle('hidden', !playing);
    roundControls.classList.toggle('hidden', playing);
    timerEl.classList.toggle('hidden', !playing);
    startBtn.textContent = state.round === 0 ? 'Start round' : 'New round';

    if (playing) {
      startTimer();
      resultBanner.classList.add('hidden');
    } else {
      stopTimer();
      if (state.state === 'ended') {
        showResult();
      } else {
        resultBanner.classList.add('hidden');
      }
    }

    // Words panel
    minLenHint.textContent =
      `${state.minLen}+ letters · first to claim a word keeps it` +
      (state.hasDictionary ? '' : ' · ✕ vetoes a made-up word');
    wordCountEl.textContent = state.words.length ? `(${state.words.length})` : '';
    wordListEl.innerHTML = '';
    state.words.forEach((w) => {
      const li = document.createElement('li');
      li.className = w.playerId === playerId ? 'mine' : '';
      const wordSpan = document.createElement('span');
      wordSpan.className = 'w';
      wordSpan.textContent = w.word.toUpperCase();
      const bySpan = document.createElement('span');
      bySpan.className = 'by';
      bySpan.textContent = w.playerName;
      const ptsSpan = document.createElement('span');
      ptsSpan.className = 'pts';
      ptsSpan.textContent = `+${w.points}`;
      li.append(wordSpan, bySpan, ptsSpan);
      const x = document.createElement('button');
      x.className = 'veto';
      x.title = 'Veto this word';
      x.textContent = '✕';
      x.addEventListener('click', () => veto(w.word));
      li.appendChild(x);
      wordListEl.appendChild(li);
    });
  }

  function showResult() {
    if (!state.players.length || state.round === 0) return;
    const sorted = state.players.slice().sort((a, b) => b.score - a.score);
    let msg;
    if (sorted.length === 1) {
      msg = `Round over — ${sorted[0].name} has ${sorted[0].score} points.`;
    } else if (sorted[0].score === sorted[1].score) {
      msg = `Round over — it's a tie at ${sorted[0].score}!`;
    } else {
      msg = `Round over — ${sorted[0].name} leads with ${sorted[0].score}!`;
    }
    resultBanner.textContent = msg;
    resultBanner.classList.remove('hidden');
  }

  // ------------------------------------------------------------------ timer
  function startTimer() {
    if (timerInterval) return;
    const tick = () => {
      if (!state || !state.roundEndsAt) return;
      const ms = Math.max(0, state.roundEndsAt - Date.now());
      const s = Math.ceil(ms / 1000);
      timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      timerEl.classList.toggle('urgent', s <= 15);
    };
    tick();
    timerInterval = setInterval(tick, 250);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  // ------------------------------------------------------------------ toast
  function toast(msg, good) {
    toastEl.textContent = msg;
    toastEl.className = 'toast show ' + (good ? 'good' : 'bad');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toastEl.className = 'toast'; }, 2500);
  }
})();
