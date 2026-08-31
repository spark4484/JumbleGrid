// JumbleGrid — zero-dependency online Boggle-style game server.
// Run with: node server.js   (then expose with: cloudflared tunnel --url http://localhost:3000)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROUND_SECONDS = 180;

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
    const j = crypto.randomInt(i + 1);
    [dice[i], dice[j]] = [dice[j], dice[i]];
  }
  return dice.map((die) => {
    const face = die[crypto.randomInt(die.length)].toLowerCase();
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

// Standard Boggle scoring; 5x5 games require 4+ letter words.
function scoreWord(word, size) {
  const len = word.length;
  const min = size === 5 ? 4 : 3;
  if (len < min) return 0;
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
      players: new Map(),      // id -> { id, name, score }
      words: [],               // { word, playerId, playerName, points }
      clients: new Set(),      // SSE responses
      endTimer: null,
    };
    rooms.set(code, room);
  }
  return room;
}

function publicState(room) {
  return {
    code: room.code,
    state: room.state,
    size: room.size,
    grid: room.grid,
    roundEndsAt: room.roundEndsAt,
    round: room.round,
    minLen: room.size === 5 ? 4 : 3,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, score: p.score })),
    words: room.words,
    hasDictionary: !!dictionary,
  };
}

function broadcast(room) {
  const payload = `data: ${JSON.stringify(publicState(room))}\n\n`;
  for (const res of room.clients) {
    res.write(payload);
  }
}

function startRound(room, size) {
  room.size = size === 5 ? 5 : 4;
  room.grid = rollGrid(room.size);
  room.words = [];
  room.state = 'playing';
  room.round += 1;
  room.roundEndsAt = Date.now() + ROUND_SECONDS * 1000;
  if (room.endTimer) clearTimeout(room.endTimer);
  room.endTimer = setTimeout(() => {
    room.state = 'ended';
    room.roundEndsAt = null;
    broadcast(room);
  }, ROUND_SECONDS * 1000);
  broadcast(room);
}

function submitWord(room, playerId, rawWord) {
  const player = room.players.get(playerId);
  if (!player) return { ok: false, reason: 'You are not in this room.' };
  if (room.state !== 'playing') return { ok: false, reason: 'No round in progress.' };
  if (Date.now() > room.roundEndsAt) return { ok: false, reason: "Time's up!" };

  const word = String(rawWord || '').toLowerCase().replace(/[^a-z]/g, '');
  const minLen = room.size === 5 ? 4 : 3;
  if (word.length < minLen) {
    return { ok: false, reason: `Words must be at least ${minLen} letters.` };
  }
  const existing = room.words.find((w) => w.word === word);
  if (existing) {
    return { ok: false, reason: `"${word.toUpperCase()}" already used by ${existing.playerName}.` };
  }
  if (!canForm(word, room.grid, room.size)) {
    return { ok: false, reason: `"${word.toUpperCase()}" can't be traced on this grid.` };
  }
  if (dictionary && !dictionary.has(word)) {
    return { ok: false, reason: `"${word.toUpperCase()}" isn't in the dictionary.` };
  }
  const points = scoreWord(word, room.size);
  player.score += points;
  room.words.unshift({ word, playerId, playerName: player.name, points });
  broadcast(room);
  return { ok: true, points };
}

function vetoWord(room, word) {
  const idx = room.words.findIndex((w) => w.word === word);
  if (idx === -1) return { ok: false, reason: 'Word not found.' };
  const [removed] = room.words.splice(idx, 1);
  const owner = room.players.get(removed.playerId);
  if (owner) owner.score -= removed.points;
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // --- Server-sent events stream ---
  if (req.method === 'GET' && url.pathname === '/events') {
    const code = normRoomCode(url.searchParams.get('room'));
    if (!code) {
      res.writeHead(400).end('Missing room');
      return;
    }
    const room = getRoom(code);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify(publicState(room))}\n\n`);
    room.clients.add(res);
    // Heartbeat keeps the tunnel connection alive.
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      room.clients.delete(res);
    });
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
          room.players.set(id, { id, name, score: 0 });
        }
        broadcast(room);
        sendJson(res, 200, { ok: true, playerId: id, room: code });
        return;
      }
      case '/api/start': {
        if (!room.players.has(body.playerId)) {
          sendJson(res, 403, { ok: false, reason: 'Join the room first.' });
          return;
        }
        startRound(room, Number(body.size));
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
        sendJson(res, 200, vetoWord(room, word));
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
});

server.listen(PORT, () => {
  console.log(`JumbleGrid listening on http://localhost:${PORT}`);
  console.log(`Share it with: cloudflared tunnel --url http://localhost:${PORT}`);
});
