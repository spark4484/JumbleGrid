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
  const wordsTitle = $('#words-title');
  const oppCounts = $('#opp-counts');
  const rotateControls = $('#rotate-controls');

  let room = null;        // room code
  let playerId = null;
  let state = null;       // last server state
  let path = [];          // selected tile indices (click-to-trace)
  let candidates = [];    // possible chains while typing (ambiguous)
  let timerInterval = null;
  let toastTimeout = null;
  let lastNoticeTs = -1;  // -1 = haven't seen any state yet

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

  const connBadge = $('#conn-badge');
  let lastEventAt = 0; // when the last SSE message arrived

  const CONN_LABELS = {
    live: '● live',
    poll: '● polling',
    down: '● reconnecting…',
    connecting: '● connecting…',
  };

  function setConn(status) {
    if (!connBadge) return; // stale index.html — don't let this kill rendering
    connBadge.className = status;
    connBadge.textContent = CONN_LABELS[status] || status;
  }

  function applyState(s) {
    try {
      state = s;
      render();
    } catch (err) {
      console.error('JumbleGrid: failed to render update', err);
      toast('Client error: ' + err.message, false);
    }
  }

  function connect() {
    setConn('connecting');
    const es = new EventSource(
      `/events?room=${encodeURIComponent(room)}&player=${encodeURIComponent(playerId)}`);
    es.onmessage = (e) => {
      lastEventAt = Date.now();
      setConn('live');
      applyState(JSON.parse(e.data));
    };
    es.onerror = (e) => {
      // EventSource auto-reconnects, but tell the user the stream is down.
      console.error('JumbleGrid: event stream error', e);
      setConn(lastEventAt ? 'down' : 'poll');
    };

    // Safety net: if the push stream is buffered/blocked (some proxies do
    // this), poll the room state so the game still works.
    setInterval(async () => {
      if (Date.now() - lastEventAt < 2500) return; // stream is delivering
      try {
        const r = await fetch(
          `/api/state?room=${encodeURIComponent(room)}&player=${encodeURIComponent(playerId)}`);
        if (r.ok) {
          if (!lastEventAt) setConn('poll');
          applyState(await r.json());
        }
      } catch (_) { /* server unreachable; SSE error handler shows status */ }
    }, 2500);
  }

  // ---------------------------------------------------------------- actions
  startBtn.addEventListener('click', async () => {
    const checked = document.querySelector('input[name="size"]:checked');
    const size = checked ? Number(checked.value) : 4;
    const modeEl = document.querySelector('input[name="mode"]:checked');
    const mode = modeEl ? modeEl.value : 'dict';
    startBtn.disabled = true;
    const resp = await api('/api/start', { room, playerId, size, mode });
    startBtn.disabled = false;
    if (resp.ok) {
      toast('Round started!', true);
    } else {
      toast(resp.reason || 'Could not start the round.', false);
    }
  });

  wordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const word = wordInput.value.trim();
    if (!word) return;
    const resp = await api('/api/word', { room, playerId, word });
    if (resp.ok) {
      toast(`Claimed ${word.toUpperCase()} — worth ${resp.points} if unpaired`, true);
      resetEntry();
    } else {
      toast(resp.reason, false);
    }
    wordInput.focus();
  });

  clearBtn.addEventListener('click', () => { resetEntry(); wordInput.focus(); });

  const rotLeft = $('#rot-left');
  const rotRight = $('#rot-right');
  rotLeft.addEventListener('click', () => api('/api/rotate', { room, playerId, dir: 'left' }));
  rotRight.addEventListener('click', () => api('/api/rotate', { room, playerId, dir: 'right' }));

  // Typing searches the grid live and highlights matching chains.
  wordInput.addEventListener('input', () => {
    if (path.length && wordInput.value === pathWord()) return; // programmatic echo
    syncTypedHighlight();
  });

  function syncTypedHighlight() {
    wordInput.classList.remove('no-match');
    path = [];
    candidates = [];
    const typed = wordInput.value.toLowerCase().replace(/[^a-z]/g, '');
    if (typed && state && state.grid && state.state === 'playing') {
      const found = findChains(typed, state.grid, state.size);
      if (found.length === 1) {
        path = found[0];          // unambiguous — show it as a full trace
      } else if (found.length > 1) {
        candidates = found;       // ambiguous — soft-highlight all possibilities
      } else {
        // Not traceable: keep the text, flag it, drop the highlights.
        wordInput.classList.add('no-match');
        void wordInput.offsetWidth; // restart the shake animation
      }
    }
    paintPath();
  }

  // All chains on the grid spelling `word` (as a prefix — a final partial
  // "qu" die also counts, so typing "sq" matches S→Qu). Capped for safety.
  function findChains(word, grid, size) {
    const results = [];
    const visited = new Array(grid.length).fill(false);
    function dfs(pos, idx, cur) {
      if (results.length >= 60) return;
      const cell = grid[pos];
      let consumed;
      if (word.startsWith(cell, idx)) {
        consumed = cell.length;
      } else if (word.length - idx < cell.length && cell.startsWith(word.slice(idx))) {
        consumed = word.length - idx; // typed a partial "qu"
      } else {
        return;
      }
      cur.push(pos);
      if (idx + consumed >= word.length) {
        results.push([...cur]);
      } else {
        visited[pos] = true;
        const r = Math.floor(pos / size);
        const c = pos % size;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const nr = r + dr;
            const nc = c + dc;
            if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
            const np = nr * size + nc;
            if (!visited[np]) dfs(np, idx + consumed, cur);
          }
        }
        visited[pos] = false;
      }
      cur.pop();
    }
    for (let i = 0; i < grid.length; i++) dfs(i, 0, []);
    return results;
  }

  function resetEntry() {
    wordInput.value = '';
    wordInput.classList.remove('no-match');
    path = [];
    candidates = [];
    paintPath();
  }

  async function veto(word) {
    const resp = await api('/api/veto', { room, playerId, word });
    if (!resp.ok) toast(resp.reason, false);
  }

  // ------------------------------------------------------------------ grid
  let dragging = false;

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
    candidates = [];
    wordInput.classList.remove('no-match');
    wordInput.value = pathWord();
    paintPath();
  }

  // Dragging over a tile appends it; dragging back one tile undoes it.
  function tileDraggedOver(idx) {
    if (!state || state.state !== 'playing') return;
    const last = path[path.length - 1];
    if (idx === last) return;
    if (idx === path[path.length - 2]) {
      path.pop(); // backtracked — undo the last tile
    } else if (!path.includes(idx) &&
               (path.length === 0 || isAdjacent(last, idx, state.size))) {
      path.push(idx);
    } else {
      return;
    }
    candidates = [];
    wordInput.classList.remove('no-match');
    wordInput.value = pathWord();
    paintPath();
  }

  function tileFromEvent(e) {
    const el = e.target && e.target.closest ? e.target.closest('.tile') : null;
    return el && el.parentElement === gridEl ? Number(el.dataset.idx) : null;
  }

  gridEl.addEventListener('pointerdown', (e) => {
    const idx = tileFromEvent(e);
    if (idx === null || !state || state.state !== 'playing') return;
    e.preventDefault(); // don't scroll/select while tracing
    // Touch implicitly captures the pointer to the pressed tile; release it
    // so pointerover fires on the tiles we drag across.
    try { e.target.releasePointerCapture(e.pointerId); } catch (_) { /* ok */ }
    dragging = true;
    tileClicked(idx);
  });

  gridEl.addEventListener('pointerover', (e) => {
    if (!dragging) return;
    const idx = tileFromEvent(e);
    if (idx !== null) tileDraggedOver(idx);
  });

  ['pointerup', 'pointercancel'].forEach((ev) =>
    window.addEventListener(ev, (e) => {
      if (dragging && e.pointerType === 'mouse') wordInput.focus(); // Enter submits right away
      dragging = false;
    }));

  function isAdjacent(a, b, n) {
    const dr = Math.abs(Math.floor(a / n) - Math.floor(b / n));
    const dc = Math.abs((a % n) - (b % n));
    return dr <= 1 && dc <= 1;
  }

  function pathWord() {
    return path.map((i) => state.grid[i]).join('');
  }

  function paintPath() {
    const inCandidate = new Set();
    for (const chain of candidates) for (const i of chain) inCandidate.add(i);
    gridEl.querySelectorAll('.tile').forEach((tile, i) => {
      tile.classList.toggle('selected', path.includes(i));
      tile.classList.toggle('head', path[path.length - 1] === i);
      tile.classList.toggle('candidate', !path.length && inCandidate.has(i));
    });
    drawTrace();
  }

  // --- trace overlay: gradient arrows showing the selection order ---
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const TRACE_FROM = [64, 156, 255]; // blue — word start
  const TRACE_TO = [225, 45, 120];   // magenta — word end

  function traceColor(t) {
    const c = TRACE_FROM.map((f, i) => Math.round(f + (TRACE_TO[i] - f) * t));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  function drawTrace() {
    const svg = gridEl.querySelector('svg.trace');
    if (!svg) return;
    svg.innerHTML = '';
    if (!path.length) return;

    const tiles = gridEl.querySelectorAll('.tile');
    const box = svg.getBoundingClientRect();
    const centers = path.map((i) => {
      const r = tiles[i].getBoundingClientRect();
      return [r.left + r.width / 2 - box.left, r.top + r.height / 2 - box.top];
    });
    const put = (name, attrs) => {
      const n = document.createElementNS(SVG_NS, name);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      svg.appendChild(n);
    };

    // Hollow ring marking where the word starts — the letter stays visible.
    const tileW = tiles[path[0]].getBoundingClientRect().width || 60;
    put('circle', {
      cx: centers[0][0], cy: centers[0][1], r: (tileW * 0.42).toFixed(1),
      fill: 'none', stroke: traceColor(0), 'stroke-width': 3, opacity: 0.9,
    });

    const segs = centers.length - 1;
    for (let i = 0; i < segs; i++) {
      const [x1, y1] = centers[i];
      const [x2, y2] = centers[i + 1];
      const color = traceColor((i + 1) / Math.max(segs, 1));
      // Draw only the middle stretch of the segment so lines never cross
      // the letters at the tile centers.
      put('line', {
        x1: x1 + (x2 - x1) * 0.3, y1: y1 + (y2 - y1) * 0.3,
        x2: x1 + (x2 - x1) * 0.7, y2: y1 + (y2 - y1) * 0.7,
        stroke: color, 'stroke-width': 4, 'stroke-linecap': 'round', opacity: 0.45,
      });
      // Arrowhead at the segment midpoint — it lands in the gap between
      // tiles, so it never covers a letter.
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const ux = (x2 - x1) / len;
      const uy = (y2 - y1) / len;
      const points = [
        [mx + ux * 9, my + uy * 9],                    // tip
        [mx - ux * 4 - uy * 7, my - uy * 4 + ux * 7],  // wing
        [mx - ux * 4 + uy * 7, my - uy * 4 - ux * 7],  // wing
      ].map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');
      put('polygon', { points, fill: color });
    }
  }

  window.addEventListener('resize', paintPath);

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
      tile.dataset.idx = i;
      gridEl.appendChild(tile);
    });
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'trace');
    gridEl.appendChild(svg);
    paintPath();
  }

  // ------------------------------------------------------------------ render
  let lastGridKey = null;

  function render() {
    // Announcements (rotation votes etc.) — skip ones older than our arrival.
    if (lastNoticeTs === -1) {
      lastNoticeTs = state.notice ? state.notice.ts : 0;
    } else if (state.notice && state.notice.ts !== lastNoticeTs) {
      lastNoticeTs = state.notice.ts;
      toast(state.notice.text, 'info');
    }

    // Scoreboard
    scoreboardEl.innerHTML = '';
    state.players
      .slice()
      .sort((a, b) => b.score - a.score)
      .forEach((p) => {
        const div = document.createElement('div');
        div.className = 'player' + (p.id === playerId ? ' me' : '');
        div.innerHTML = `<span class="pname"></span><span class="pscore">${p.score}</span>`;
        div.querySelector('.pname').textContent = p.name + (p.id === state.hostId ? ' ★' : '');
        if (p.id === state.hostId) div.title = 'Room host — breaks challenge-vote ties';
        scoreboardEl.appendChild(div);
      });

    // Grid (rebuild only when it changes, so selection survives re-renders)
    const gridKey = `${state.round}:${(state.grid || []).join(',')}`;
    if (gridKey !== lastGridKey) {
      lastGridKey = gridKey;
      path = [];
      candidates = [];
      wordInput.value = '';
      wordInput.classList.remove('no-match');
      renderGrid();
    }

    // Round controls / timer / input
    const playing = state.state === 'playing';
    wordForm.classList.toggle('hidden', !playing);
    roundControls.classList.toggle('hidden', playing);
    timerEl.classList.toggle('hidden', !playing);
    startBtn.textContent = state.round === 0 ? 'Start round' : 'New round';

    // Mode picker only matters when a dictionary is loaded
    $('#mode-picker').classList.toggle('hidden', !state.hasDictionary);

    // Rotation vote buttons
    rotateControls.classList.toggle('hidden', !playing);
    if (state.rotate) {
      const { left, right, total, yours } = state.rotate;
      rotLeft.querySelector('.rot-n').textContent = left ? ` ${left}/${total}` : '';
      rotRight.querySelector('.rot-n').textContent = right ? ` ${right}/${total}` : '';
      rotLeft.classList.toggle('voted', yours === 'left');
      rotRight.classList.toggle('voted', yours === 'right');
    }

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

    // Words panel — your own list during play, everyone's at round end.
    wordsTitle.textContent = playing ? 'Your words' : (state.round ? 'All words' : 'Words');
    minLenHint.textContent = state.mode === 'open'
      ? `${state.minLen}+ letters · duplicates cancel · no dictionary — bluff wisely, 🚩 fishy words after the round`
      : `${state.minLen}+ letters · duplicate words cancel at round end`;
    oppCounts.textContent = playing
      ? (state.wordCounts || [])
          .filter((c) => c.id !== playerId)
          .map((c) => `${c.name}: ${c.count} word${c.count === 1 ? '' : 's'}`)
          .join(' · ')
      : '';
    wordCountEl.textContent = state.words.length ? `(${state.words.length})` : '';
    wordListEl.innerHTML = '';

    const addWordLi = (w) => {
      const li = document.createElement('li');
      li.className = (w.playerId === playerId ? 'mine' : '') + (w.cancelled ? ' cancelled' : '');
      if (w.cancelled) {
        const others = state.words
          .filter((o) => o.word === w.word && o.playerId !== w.playerId)
          .map((o) => o.playerName);
        li.title = `Also used by ${others.join(', ')}`;
      }
      const wordSpan = document.createElement('span');
      wordSpan.className = 'w';
      wordSpan.textContent = w.word.toUpperCase();
      const ptsSpan = document.createElement('span');
      ptsSpan.className = 'pts';
      ptsSpan.textContent = w.cancelled ? '✗ dup' : `+${w.points}`;
      li.append(wordSpan, ptsSpan);
      const ended = state.state === 'ended';
      if (w.challenge && ended) {
        appendChallengeRow(li, w);
      } else {
        if (w.defended) {
          const shield = document.createElement('span');
          shield.className = 'defended';
          shield.textContent = '🛡';
          shield.title = 'Survived a challenge';
          li.appendChild(shield);
        }
        const openEnded = ended && state.mode === 'open';
        if (w.playerId === playerId || !openEnded) {
          const x = document.createElement('button');
          x.className = 'veto';
          x.title = w.playerId === playerId ? 'Remove this word' : 'Veto this word';
          x.textContent = '✕';
          x.addEventListener('click', () => veto(w.word));
          li.appendChild(x);
        } else if (!w.cancelled && !w.defended) {
          // Challenge mode: removing someone else's word takes a vote.
          const flag = document.createElement('button');
          flag.className = 'veto flag';
          flag.title = 'Fishy? Challenge this word — everyone votes';
          flag.textContent = '🚩';
          flag.addEventListener('click', async () => {
            const r = await api('/api/challenge', { room, playerId, word: w.word });
            if (!r.ok) toast(r.reason, false);
          });
          li.appendChild(flag);
        }
      }
      wordListEl.appendChild(li);
    };

    const appendChallengeRow = (li, w) => {
      li.classList.add('challenged');
      const row = document.createElement('div');
      row.className = 'challenge-row';
      const info = document.createElement('span');
      info.className = 'challenge-info';
      info.textContent = `🚩 ${w.challenge.byName}`;
      row.appendChild(info);
      const votes = w.challenge.votes || {};
      const nameOf = (id) => {
        const p = state.players.find((x) => x.id === id);
        return p ? p.name : '?';
      };
      for (const verdict of ['real', 'fake']) {
        const voters = Object.keys(votes).filter((id) => votes[id] === verdict).map(nameOf);
        const btn = document.createElement('button');
        btn.className = 'vote-btn' + (votes[playerId] === verdict ? ' voted' : '');
        btn.textContent = (verdict === 'real' ? '✓ real' : '✗ fake') +
          (voters.length ? ` · ${voters.join(', ')}` : '');
        btn.addEventListener('click', async () => {
          const r = await api('/api/challenge-vote', { room, playerId, word: w.word, verdict });
          if (!r.ok) toast(r.reason, false);
        });
        row.appendChild(btn);
      }
      li.appendChild(row);
    };

    if (playing || !state.round) {
      state.words.forEach(addWordLi);
    } else {
      // Round over — group every player's list for comparison, unique words first.
      const order = state.result ? state.result.players : state.players;
      for (const p of order) {
        const head = document.createElement('li');
        head.className = 'player-head';
        head.textContent = `${p.name} — ${p.unpaired ?? 0} unique · ${p.cancelled ?? 0} dup` +
          (p.roundPoints !== undefined ? ` · +${p.roundPoints} pts` : '');
        wordListEl.appendChild(head);
        state.words
          .filter((w) => w.playerId === p.id)
          .sort((a, b) => (a.cancelled - b.cancelled) || a.word.localeCompare(b.word))
          .forEach(addWordLi);
      }
    }
  }

  function showResult() {
    const r = state.result;
    if (!r || !r.players.length) return;
    const head = r.winners.length === 1
      ? `🏆 ${r.winners[0]} wins the round!`
      : `🤝 Tie between ${r.winners.join(' & ')}!`;
    const detail = r.players
      .map((p) => `${p.name}: ${p.unpaired} unpaired word${p.unpaired === 1 ? '' : 's'}` +
        ` (+${p.roundPoints} pts${p.cancelled ? `, ${p.cancelled} cancelled` : ''})`)
      .join(' · ');
    resultBanner.textContent = `${head} ${detail}`;
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
  function toast(msg, kind) {
    toastEl.textContent = msg;
    toastEl.className = 'toast show ' + (kind === 'info' ? 'info' : kind ? 'good' : 'bad');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toastEl.className = 'toast'; }, 2500);
  }
})();
