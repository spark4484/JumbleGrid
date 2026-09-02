// JumbleGrid — zero-dependency online Boggle-style game server.
// Run with: node server.js   (then expose with: cloudflared tunnel --url http://localhost:3000)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS) || 180;

// Never die silently — log and keep serving.
process.on('uncaughtException', (err) => console.error('[fatal-ish] uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('[fatal-ish] unhandled rejection:', err));

// crypto.randomInt needs Node >= 14.10; fall back to Math.random just in case.
const randInt = typeof crypto.randomInt === 'function'
  ? (n) => crypto.randomInt(n)
  : (n) => Math.floor(Math.random() * n);

// ---------------------------------------------------------------------------
// Optional dictionary. Drop an `words.txt` (one word per line) next to this
// file to enable dictionary checking; otherwise all grid-valid words are
// accepted and players police each other with the veto (✕) button.
// ---------------------------------------------------------------------------
let dictionary = null;
for (const p of [path.join(__dirname, 'words.txt'), '/usr/share/dict/words']) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    dictionary = new Set(
      raw.split(/\r?\n/)
        .map((w) => w.trim().toLowerCase())
        .filter((w) => /^[a-z]+$/.test(w))
    );
    console.log(`Loaded dictionary ${p} (${dictionary.size} words)`);
    break;
  } catch (_) { /* try next */ }
}
if (!dictionary) {
  console.log('No dictionary found (words.txt) — grid-valid words are accepted; use the veto button for fakes.');
}

// ---------------------------------------------------------------------------
// Dice — the classic Boggle 16-die set and the Big Boggle 25-die set.
// ---------------------------------------------------------------------------
const DICE_4 = [
  'AAEEGN', 'ABBJOO', 'ACHOPS', 'AFFKPS',
  'AOOTTW', 'CIMOTU', 'DEILRX', 'DELRVY',
  'DISTTY', 'EEGHNW', 'EEINSU', 'EHRTVW',
  'EIOSST', 'ELRTTY', 'HIMNQU', 'HLNNRZ',
];
const DICE_5 = [
  'AAAFRS', 'AAEEEE', 'AAFIRS', 'ADENNN', 'AEEEEM',
  'AEEGMU', 'AEGMNN', 'AFIRSY', 'BJKQXZ', 'CCNSTW',
  'CEIILT', 'CEILPT', 'CEIPST', 'DDLNOR', 'DHHLOR',
  'DHHNOT', 'DHLNOR', 'EIIITT', 'EMOTTT', 'ENSSSU',
  'FIPRSY', 'GORRVW', 'HIPRRY', 'NOOTUW', 'OOOTTU',
];

function rollGrid(size) {
  const dice = (size === 5 ? DICE_5 : DICE_4).slice();
  // Fisher–Yates shuffle of the dice, then roll each one.
  for (let i = dice.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [dice[i], dice[j]] = [dice[j], dice[i]];
  }
  return dice.map((die) => {
    const face = die[randInt(die.length)].toLowerCase();
    return face === 'q' ? 'qu' : face;
  });
}

// Can `word` be traced on the grid (each die used at most once, 8-way adjacency)?
function canForm(word, grid, size) {
  const visited = new Array(grid.length).fill(false);
  function dfs(pos, idx) {
    const cell = grid[pos];
    if (!word.startsWith(cell, idx)) return false;
    const next = idx + cell.length;
    if (next === word.length) return true;
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
        if (!visited[np] && dfs(np, next)) {
          visited[pos] = false;
          return true;
        }
      }
    }
    visited[pos] = false;
    return false;
  }
  for (let i = 0; i < grid.length; i++) {
    if (dfs(i, 0)) return true;
  }
  return false;
}

// Rotate the whole board 90° left or right (same view for every player).
function rotateGrid(grid, size, dir) {
  const out = new Array(grid.length);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      out[r * size + c] = dir === 'right'
        ? grid[(size - 1 - c) * size + r]  // clockwise
        : grid[c * size + (size - 1 - r)]; // counter-clockwise
    }
  }
  return out;
}

// Standard Boggle length scoring; 3+ letters on both grid sizes.
function scoreWord(word, size) {
  const len = word.length;
  if (len < 3) return 0;
  if (len <= 4) return 1;
  if (len === 5) return 2;
  if (len === 6) return 3;
  if (len === 7) return 5;
  return 11;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
const rooms = new Map();

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      state: 'lobby',          // lobby | playing | ended
      size: 4,
      grid: null,
      roundEndsAt: null,
      round: 0,
      mode: dictionary ? 'dict' : 'open', // 'dict' = auto-check, 'open' = challenge after
      hostId: null,            // first player to join; breaks challenge-vote ties
      players: new Map(),      // id -> { id, name, score, scoreBase }
      words: [],               // { word, playerId, playerName, points, cancelled?, challenge?, defended? }
      clients: new Set(),      // SSE responses (each tagged with .viewerId)
      endTimer: null,
      rotateVotes: new Map(),  // playerId -> 'left' | 'right'
      notice: null,            // { text, ts } — transient announcement
      lastResult: null,        // end-of-round tally
    };
    rooms.set(code, room);
  }
  return room;
}

function publicState(room, viewerId) {
  const playing = room.state === 'playing';
  const countVotes = (dir) =>
    [...room.players.keys()].filter((id) => room.rotateVotes.get(id) === dir).length;
  return {
    code: room.code,
    state: room.state,
    size: room.size,
    grid: room.grid,
    roundEndsAt: room.roundEndsAt,
    round: room.round,
    minLen: 3,
    mode: room.mode,
    hostId: room.hostId,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, score: p.score })),
    // During play you only see your own list — otherwise you could peek at
    // your opponent's words to dodge duplicates. Everything is revealed at the end.
    words: playing ? room.words.filter((w) => w.playerId === viewerId) : room.words,
    wordCounts: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      count: room.words.filter((w) => w.playerId === p.id).length,
    })),
    result: room.state === 'ended' ? room.lastResult : null,
    rotate: {
      left: countVotes('left'),
      right: countVotes('right'),
      total: room.players.size,
      yours: room.rotateVotes.get(viewerId) || null,
    },
    notice: room.notice,
    hasDictionary: !!dictionary,
  };
}

function broadcast(room) {
  for (const res of room.clients) {
    res.write(`data: ${JSON.stringify(publicState(room, res.viewerId))}\n\n`);
  }
}

function setNotice(room, text) {
  room.notice = { text, ts: Date.now() };
}

// Duplicate words cancel; the rest ("unpaired") count. Winner = most unpaired
// words. Idempotent so a post-round veto can just re-run it.
function finishRound(room) {
  const counts = new Map();
  for (const w of room.words) counts.set(w.word, (counts.get(w.word) || 0) + 1);
  for (const w of room.words) w.cancelled = counts.get(w.word) >= 2;

  const tally = [];
  for (const p of room.players.values()) {
    const mine = room.words.filter((w) => w.playerId === p.id);
    const unpaired = mine.filter((w) => !w.cancelled);
    const roundPoints = unpaired.reduce((s, w) => s + w.points, 0);
    p.score = (p.scoreBase || 0) + roundPoints;
    tally.push({
      id: p.id,
      name: p.name,
      unpaired: unpaired.length,
      cancelled: mine.length - unpaired.length,
      roundPoints,
    });
  }
  tally.sort((a, b) => b.unpaired - a.unpaired || b.roundPoints - a.roundPoints);
  room.lastResult = {
    players: tally,
    winners: tally.length ? tally.filter((t) => t.unpaired === tally[0].unpaired).map((t) => t.name) : [],
  };
}

function startRound(room, size, mode) {
  // Only change mode/size when explicitly given — the room's current settings
  // are the default, so "New round" keeps playing the same way.
  if (mode === 'open' || mode === 'dict') room.mode = mode;
  if (!dictionary) room.mode = 'open';
  if (size === 4 || size === 5) room.size = size;
  room.grid = rollGrid(room.size);
  room.words = [];
  room.state = 'playing';
  room.round += 1;
  room.roundEndsAt = Date.now() + ROUND_SECONDS * 1000;
  room.rotateVotes.clear();
  room.lastResult = null;
  for (const p of room.players.values()) p.scoreBase = p.score;
  if (room.endTimer) clearTimeout(room.endTimer);
  room.endTimer = setTimeout(() => {
    room.state = 'ended';
    room.roundEndsAt = null;
    finishRound(room);
    broadcast(room);
  }, ROUND_SECONDS * 1000);
  console.log(`[game] room ${room.code} round ${room.round} started (${room.size}x${room.size}): ${room.grid.join(' ')}`);
  broadcast(room);
}

function submitWord(room, playerId, rawWord) {
  const player = room.players.get(playerId);
  if (!player) return { ok: false, reason: 'You are not in this room.' };
  if (room.state !== 'playing') return { ok: false, reason: 'No round in progress.' };
  if (Date.now() > room.roundEndsAt) return { ok: false, reason: "Time's up!" };

  const word = String(rawWord || '').toLowerCase().replace(/[^a-z]/g, '');
  if (word.length < 3) {
    return { ok: false, reason: 'Words must be at least 3 letters.' };
  }
  // Both players may claim the same word — duplicates cancel at round end.
  if (room.words.some((w) => w.word === word && w.playerId === playerId)) {
    return { ok: false, reason: `You already used "${word.toUpperCase()}".` };
  }
  if (!canForm(word, room.grid, room.size)) {
    return { ok: false, reason: `"${word.toUpperCase()}" can't be traced on this grid.` };
  }
  if (room.mode === 'dict' && dictionary && !dictionary.has(word)) {
    return { ok: false, reason: `"${word.toUpperCase()}" isn't in the dictionary.` };
  }
  const points = scoreWord(word, room.size);
  room.words.unshift({ word, playerId, playerName: player.name, points });
  broadcast(room);
  return { ok: true, points };
}

function vetoWord(room, word, requesterId) {
  // During play you can only retract your own words (you can't see others').
  // In challenge mode, removing someone else's word goes through a vote, not ✕.
  const idx = room.words.findIndex((w) =>
    w.word === word &&
    (room.state !== 'playing' && room.mode !== 'open' ? true : w.playerId === requesterId));
  if (idx === -1) return { ok: false, reason: 'Word not found.' };
  const [removed] = room.words.splice(idx, 1);
  if (room.state === 'ended') {
    finishRound(room); // recompute cancellations and scores
    const requester = room.players.get(requesterId);
    setNotice(room, `${requester ? requester.name : 'Someone'} vetoed "${removed.word.toUpperCase()}" — scores recomputed.`);
  }
  broadcast(room);
  return { ok: true };
}

// --- challenge mode: flag a fishy word, then everyone votes real/fake ---
function challengeWord(room, playerId, word) {
  const player = room.players.get(playerId);
  if (!player) return { ok: false, reason: 'You are not in this room.' };
  if (room.state !== 'ended') return { ok: false, reason: 'Challenges happen after the round.' };
  if (room.mode !== 'open') return { ok: false, reason: 'No challenges in dictionary mode.' };
  const w = room.words.find((x) => x.word === word && x.playerId !== playerId);
  if (!w) return { ok: false, reason: 'Word not found.' };
  if (w.cancelled) return { ok: false, reason: 'That word is already cancelled.' };
  if (w.challenge) return { ok: false, reason: 'A vote on that word is already open.' };
  if (w.defended) return { ok: false, reason: 'That word already survived a challenge.' };
  w.challenge = { by: playerId, byName: player.name, votes: { [playerId]: 'fake' } };
  setNotice(room, `${player.name} challenged "${word.toUpperCase()}" — vote real or fake!`);
  resolveChallenge(room, w); // resolves immediately in a 1-player room
  broadcast(room);
  return { ok: true };
}

function voteOnChallenge(room, playerId, word, verdict) {
  const player = room.players.get(playerId);
  if (!player) return { ok: false, reason: 'You are not in this room.' };
  const w = room.words.find((x) => x.word === word && x.challenge);
  if (!w) return { ok: false, reason: 'No open vote on that word.' };
  w.challenge.votes[playerId] = verdict === 'fake' ? 'fake' : 'real';
  resolveChallenge(room, w);
  broadcast(room);
  return { ok: true };
}

// Once every player has voted: majority rules, host breaks ties.
function resolveChallenge(room, w) {
  const ids = [...room.players.keys()];
  if (!ids.every((id) => w.challenge.votes[id])) return;
  const fake = ids.filter((id) => w.challenge.votes[id] === 'fake').length;
  const real = ids.length - fake;
  const upper = w.word.toUpperCase();
  let remove;
  if (fake !== real) {
    remove = fake > real;
    setNotice(room, remove
      ? `"${upper}" voted fake ${fake}–${real} — removed!`
      : `"${upper}" voted real ${real}–${fake} — it stands.`);
  } else {
    remove = w.challenge.votes[room.hostId] === 'fake';
    setNotice(room, `"${upper}" tied ${fake}–${real} — host says ${remove ? 'fake, removed!' : 'real, it stands.'}`);
  }
  if (remove) {
    room.words.splice(room.words.indexOf(w), 1);
    finishRound(room); // recompute cancellations and scores
  } else {
    w.challenge = null;
    w.defended = true;
  }
}

function voteRotate(room, playerId, dir) {
  const player = room.players.get(playerId);
  if (!player) return { ok: false, reason: 'You are not in this room.' };
  if (room.state !== 'playing') return { ok: false, reason: 'No round in progress.' };
  if (room.rotateVotes.get(playerId) === dir) {
    room.rotateVotes.delete(playerId); // clicking again withdraws the vote
    setNotice(room, `${player.name} withdrew their rotation vote.`);
  } else {
    room.rotateVotes.set(playerId, dir);
    const votes = [...room.players.keys()].filter((id) => room.rotateVotes.get(id) === dir).length;
    const total = room.players.size;
    if (votes === total) {
      room.grid = rotateGrid(room.grid, room.size, dir);
      room.rotateVotes.clear();
      setNotice(room, `Board rotated ${dir}!`);
    } else {
      setNotice(room, `${player.name} voted to rotate the board ${dir} (${votes}/${total}).`);
    }
  }
  broadcast(room);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(__dirname, 'public', path.normalize(rel));
  if (!file.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache', // always revalidate — stale client code causes confusing bugs
    });
    res.end(data);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function normRoomCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`[error] ${req.method} ${req.url}:`, err);
    try {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, reason: `Server error: ${err.message}` });
      } else {
        res.end();
      }
    } catch (_) { /* response already gone */ }
  });
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');

  // --- Server-sent events stream ---
  if (req.method === 'GET' && url.pathname === '/events') {
    const code = normRoomCode(url.searchParams.get('room'));
    if (!code) {
      res.writeHead(400).end('Missing room');
      return;
    }
    const room = getRoom(code);
    res.viewerId = url.searchParams.get('player') || null;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify(publicState(room, res.viewerId))}\n\n`);
    room.clients.add(res);
    console.log(`[sse] client connected to room ${code} (${room.clients.size} watching)`);
    // Heartbeat keeps the tunnel connection alive.
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      room.clients.delete(res);
      console.log(`[sse] client left room ${code} (${room.clients.size} watching)`);
    });
    return;
  }

  // --- Polling fallback: current room state as plain JSON ---
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const code = normRoomCode(url.searchParams.get('room'));
    if (!code) {
      sendJson(res, 400, { ok: false, reason: 'Missing room' });
      return;
    }
    sendJson(res, 200, publicState(getRoom(code), url.searchParams.get('player') || null));
    return;
  }

  // --- JSON API ---
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, reason: 'Bad request body.' });
      return;
    }
    const code = normRoomCode(body.room);
    if (!code) {
      sendJson(res, 400, { ok: false, reason: 'Missing room code.' });
      return;
    }
    const room = getRoom(code);
    console.log(`[api] ${url.pathname} room=${code}`);

    switch (url.pathname) {
      case '/api/join': {
        const name = String(body.name || '').trim().slice(0, 20);
        if (!name) {
          sendJson(res, 400, { ok: false, reason: 'Please enter a name.' });
          return;
        }
        let id = body.playerId;
        if (id && room.players.has(id)) {
          room.players.get(id).name = name; // rejoin, possibly renamed
        } else {
          id = crypto.randomBytes(8).toString('hex');
          room.players.set(id, { id, name, score: 0, scoreBase: 0 });
        }
        if (!room.hostId) room.hostId = id;
        broadcast(room);
        sendJson(res, 200, { ok: true, playerId: id, room: code });
        return;
      }
      case '/api/start': {
        if (!room.players.has(body.playerId)) {
          sendJson(res, 403, { ok: false, reason: 'Join the room first.' });
          return;
        }
        startRound(room, Number(body.size), body.mode);
        sendJson(res, 200, { ok: true });
        return;
      }
      case '/api/word': {
        const result = submitWord(room, body.playerId, body.word);
        sendJson(res, 200, result);
        return;
      }
      case '/api/veto': {
        if (!room.players.has(body.playerId)) {
          sendJson(res, 403, { ok: false, reason: 'Join the room first.' });
          return;
        }
        const word = String(body.word || '').toLowerCase().replace(/[^a-z]/g, '');
        sendJson(res, 200, vetoWord(room, word, body.playerId));
        return;
      }
      case '/api/rotate': {
        const dir = body.dir === 'left' ? 'left' : 'right';
        sendJson(res, 200, voteRotate(room, body.playerId, dir));
        return;
      }
      case '/api/challenge': {
        const word = String(body.word || '').toLowerCase().replace(/[^a-z]/g, '');
        sendJson(res, 200, challengeWord(room, body.playerId, word));
        return;
      }
      case '/api/challenge-vote': {
        const word = String(body.word || '').toLowerCase().replace(/[^a-z]/g, '');
        sendJson(res, 200, voteOnChallenge(room, body.playerId, word, body.verdict));
        return;
      }
      default:
        sendJson(res, 404, { ok: false, reason: 'Unknown endpoint.' });
        return;
    }
  }

  // --- Static files ---
  if (req.method === 'GET') {
    serveStatic(req, res, url.pathname);
    return;
  }

  res.writeHead(405).end('Method not allowed');
}

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use — is another copy of the server running?`
    : err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`JumbleGrid listening on http://localhost:${PORT}`);
  console.log(`Share it with: cloudflared tunnel --url http://localhost:${PORT}`);
});
