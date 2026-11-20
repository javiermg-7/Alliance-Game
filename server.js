'use strict';
/*
 * Allaince Game - zero-dependency Node.js server.
 * Run:  node server.js     (then open http://localhost:3000)
 *
 * Config via environment variables (applied when a new game is created / reset):
 *   GRID_SIZE=16  MAX_PLAYERS=16  AP_INTERVAL_SECONDS=600  LIVES=3  START_RANGE=2
 *   PORT=3000  ADMIN_PASSWORD=...  (random one is printed if not set)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const HTML_FILE = path.join(__dirname, 'index.html');

let ADMIN_PASSWORD = "administrador";
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(6).toString('hex');
  console.log('No ADMIN_PASSWORD set. Random admin password for this run: ' + ADMIN_PASSWORD);
}

/* ---------- helpers ---------- */
const httpErr = (status, message) => Object.assign(new Error(message), { status });

function envConfig() {
  const int = (name, def, min, max) => {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
  };
  const gridSize = int('GRID_SIZE', 16, 4, 64);
  return {
    gridSize,
    maxPlayers: int('MAX_PLAYERS', 16, 2, gridSize * gridSize),
    apIntervalSeconds: int('AP_INTERVAL_SECONDS', 436800, 1, 7 * 86400),
    lives: int('LIVES', 3, 1, 20),
    startRange: int('START_RANGE', 2, 1, gridSize),
    costs: { move: 1, attack: 1, range: 3, heal: 3 }, 
  };
}

function newState() {
  return {
    config: envConfig(),
    phase: 'lobby', // lobby -> playing -> finished
    players: {},    // key: lowercase name
    sessions: {},   // token -> player id
    events: [],
    nextTick: null,
    winner: null,
  };
}

/* ---------- persistence ---------- */
let state;
try {
  state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
  state = newState();
}
let dirty = true;
const save = () => { dirty = true; };
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  try {
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(state));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  } catch (e) { console.error('Could not save state:', e.message); }
}, 1000);

/* ---------- passwords & auth ---------- */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
function checkPw(pw, p) {
  const a = Buffer.from(hashPw(pw, p.salt), 'hex');
  const b = Buffer.from(p.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function checkAdmin(pw) {
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  if (!crypto.timingSafeEqual(h(pw), h(ADMIN_PASSWORD))) throw httpErr(403, 'Wrong admin password');
}
function auth(req) {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const id = state.sessions[m[1]];
  return id && state.players[id] ? state.players[id] : null;
}
const attempts = new Map();
function limit(req) {
  const ip = req.socket.remoteAddress;
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || now > a.reset) { a = { n: 0, reset: now + 60000 }; attempts.set(ip, a); }
  if (++a.n > 20) throw httpErr(429, 'Too many attempts, wait a minute');
}
function newSession(p) {
  const token = crypto.randomBytes(32).toString('hex');
  state.sessions[token] = p.id;
  save();
  return token;
}

/* ---------- game logic ---------- */
const alivePlayers = () => Object.values(state.players).filter((p) => p.alive);
const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function log(msg, to = null) {
  state.events.push({ t: Date.now(), msg, to });
  if (state.events.length > 300) state.events.splice(0, state.events.length - 300);
}

function tick(now = Date.now()) {
  if (state.phase !== 'playing') return;
  const ms = state.config.apIntervalSeconds * 1000;
  if (now < state.nextTick) return;
  const n = Math.floor((now - state.nextTick) / ms) + 1;
  alivePlayers().forEach((p) => { p.points += n; });
  state.nextTick += n * ms;
  save();
}

function startGame() {
  const list = Object.values(state.players);
  if (state.phase !== 'lobby') throw httpErr(400, 'The game already started');
  if (list.length < 2) throw httpErr(400, 'At least 2 players are needed');
  const c = state.config;
  const cells = [];
  for (let i = 0; i < c.gridSize * c.gridSize; i++) cells.push(i);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  list.forEach((p, i) => {
    p.x = cells[i] % c.gridSize;
    p.y = Math.floor(cells[i] / c.gridSize);
    p.lives = c.lives;
    p.points = 1;
    p.range = c.startRange;
    p.alive = true;
  });
  state.phase = 'playing';
  state.nextTick = Date.now() + c.apIntervalSeconds * 1000;
  log('The game has started with ' + list.length + ' players. Good luck!');
  save();
}

function checkWinner() {
  const alive = alivePlayers();
  if (alive.length <= 1) {
    state.phase = 'finished';
    state.winner = alive[0] ? alive[0].name : null;
    log(state.winner ? 'Game over! ' + state.winner + ' is the last player standing.' : 'Game over!');
  }
}

function pay(p, n) {
  if (p.points < n) throw httpErr(400, 'Not enough points (need ' + n + ')');
  p.points -= n;
}

function targetOf(p, name) {
  const t = state.players[String(name || '').toLowerCase()];
  if (!t || !t.alive) throw httpErr(400, 'That target does not exist or is eliminated');
  if (t === p) throw httpErr(400, 'You cannot target yourself');
  if (cheb(p, t) > p.range) throw httpErr(400, 'Target is out of range');
  return t;
}

function act(p, b) {
  if (state.phase === 'lobby') throw httpErr(400, 'The game has not started yet');
  if (state.phase === 'finished') throw httpErr(400, 'The game is over');
  if (!p.alive) throw httpErr(400, 'You have been eliminated');
  const c = state.config;
  switch (b.type) {
    case 'move': {
      const dx = Number(b.dx), dy = Number(b.dy);
      const ok = [dx, dy].every((v) => Number.isInteger(v) && v >= -1 && v <= 1) && (dx !== 0 || dy !== 0);
      if (!ok) throw httpErr(400, 'Invalid direction');
      const nx = p.x + dx, ny = p.y + dy;
      if (nx < 0 || ny < 0 || nx >= c.gridSize || ny >= c.gridSize) throw httpErr(400, 'That is outside the grid');
      if (alivePlayers().some((o) => o.x === nx && o.y === ny)) throw httpErr(400, 'That cell is occupied');
      pay(p, c.costs.move);
      p.x = nx; p.y = ny;
      break;
    }
    case 'attack': {
      const t = targetOf(p, b.target);
      pay(p, c.costs.attack);
      t.lives -= 1;
      log('You attacked ' + t.name + '.', [p.id]);
      if (t.lives <= 0) {
        t.alive = false;
        t.points = 0;
        log(t.name + ' was eliminated by ' + p.name + '!');
        checkWinner();
      } else {
        log(p.name + ' attacked you!', [t.id]);
      }
      break;
    }
    case 'gift': {
      const amount = Number(b.amount);
      if (!Number.isInteger(amount) || amount < 1) throw httpErr(400, 'Invalid amount');
      const t = targetOf(p, b.target);
      pay(p, amount);
      t.points += amount;
      log('You sent ' + amount + ' point(s) to ' + t.name + '.', [p.id]);
      log(p.name + ' sent you ' + amount + ' point(s).', [t.id]);
      break;
    }
    case 'range': {
      if (p.range >= c.gridSize) throw httpErr(400, 'Range is already at the maximum');
      pay(p, c.costs.range);
      p.range += 1;
      break;
    }
    case 'heal': {
      if (p.lives >= c.lives) throw httpErr(400, 'You are already at maximum lives');
      pay(p, c.costs.heal);
      p.lives += 1;
      break;
    }
    default:
      throw httpErr(400, 'Unknown action');
  }
  save();
}

/* What a given player is allowed to see. Other players' lives, points and range are never sent. */
function view(me) {
  const c = state.config;
  const all = Object.values(state.players);
  return {
    config: { gridSize: c.gridSize, maxPlayers: c.maxPlayers, apIntervalSeconds: c.apIntervalSeconds, lives: c.lives, costs: c.costs },
    phase: state.phase,
    winner: state.winner,
    serverTime: Date.now(),
    nextTick: state.nextTick,
    joined: all.length,
    lobby: state.phase === 'lobby' ? all.map((p) => p.name) : [],
    players: state.phase === 'lobby' ? [] : all.filter((p) => p.alive).map((p) => ({ name: p.name, x: p.x, y: p.y })),
    eliminated: all.filter((p) => p.alive === false).map((p) => p.name),
    me: me ? { name: me.name, x: me.x, y: me.y, lives: me.lives, points: me.points, range: me.range, alive: me.alive } : null,
    events: state.events
      .filter((e) => !e.to || (me && e.to.includes(me.id)))
      .slice(-60)
      .map((e) => ({ t: e.t, msg: e.msg })),
  };
}

/* ---------- HTTP ---------- */
function send(res, status, body, type) {
  const data = type ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10000) { reject(httpErr(413, 'Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(httpErr(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const NAME_RE = /^[A-Za-z0-9_-]{3,16}$/;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(HTML_FILE), 'text/html; charset=utf-8');
    }
    if (!url.pathname.startsWith('/api/')) throw httpErr(404, 'Not found');

    tick();
    const me = auth(req);
    const route = req.method + ' ' + url.pathname;

    if (route === 'GET /api/state') return send(res, 200, view(me));

    const body = await readBody(req);

    switch (route) {
      case 'POST /api/register': {
        limit(req);
        const name = String(body.name || '').trim();
        const password = String(body.password || '');
        if (!NAME_RE.test(name)) throw httpErr(400, 'Name: 3-16 characters, letters, numbers, _ or -');
        if (password.length < 6 || password.length > 100) throw httpErr(400, 'Password must be 6-100 characters');
        if (state.phase !== 'lobby') throw httpErr(400, 'The game already started. No new players can join.');
        if (Object.keys(state.players).length >= state.config.maxPlayers) throw httpErr(400, 'The game is full');
        const id = name.toLowerCase();
        if (state.players[id]) throw httpErr(400, 'That name is already taken');
        const salt = crypto.randomBytes(16).toString('hex');
        const p = { id, name, salt, hash: hashPw(password, salt), x: null, y: null, lives: null, points: null, range: null, alive: null };
        state.players[id] = p;
        log(name + ' joined the game.');
        if (Object.keys(state.players).length >= state.config.maxPlayers) startGame();
        save();
        return send(res, 200, { token: newSession(p) });
      }
      case 'POST /api/login': {
        limit(req);
        const p = state.players[String(body.name || '').trim().toLowerCase()];
        if (!p || !checkPw(String(body.password || ''), p)) throw httpErr(401, 'Wrong name or password');
        return send(res, 200, { token: newSession(p) });
      }
      case 'POST /api/action': {
        if (!me) throw httpErr(401, 'Please log in');
        act(me, body);
        return send(res, 200, view(me));
      }
      case 'POST /api/admin/start': {
        limit(req);
        checkAdmin(body.password);
        startGame();
        return send(res, 200, view(me));
      }
      case 'POST /api/admin/reset': {
        limit(req);
        checkAdmin(body.password);
        state = newState();
        save();
        return send(res, 200, { ok: true });
      }
      default:
        throw httpErr(404, 'Not found');
    }
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

// Give points even if nobody is polling, and keep state fresh.
setInterval(() => tick(), 1000);

server.listen(PORT, () => console.log('Alliance Game running on http://localhost:' + PORT));