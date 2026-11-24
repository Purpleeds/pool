'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const Core = require('./public/core.js');

const PORT = process.env.PORT || 3000;
const SEAT_GRACE_MS = 2 * 60 * 1000;   // keep a dropped player's seat this long
const ROOM_IDLE_MS = 15 * 60 * 1000;   // delete rooms nobody is in after this

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); },
}));

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 8000, maxHttpBufferSize: 16e3 });

/** @type {Map<string, any>} */
const rooms = new Map();
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function newCode() {
  for (let tries = 0; tries < 1000; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += LETTERS[Math.floor(Math.random() * LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('no free room codes');
}

function cleanName(n) {
  return String(n || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16) || 'Player';
}
function cleanId(id) { return String(id || '').slice(0, 64); }
const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0; };

function roomView(room, seat) {
  return {
    code: room.code, you: seat, gameId: room.gameId, state: room.state,
    players: room.players.map((p) => (p ? { name: p.name, connected: p.connected } : null)),
    spectators: room.spectators.size, rematch: room.rematch.slice(), score: room.score.slice(),
  };
}

function broadcastRoom(room) {
  for (const [id, s] of io.of('/').sockets) {
    if (s.data.code === room.code) s.emit('room', roomView(room, s.data.seat));
  }
}

function startGame(room, newOpponent) {
  if (newOpponent) room.score = [0, 0];
  room.gameId++;
  room.state = Core.newGame(room.breaker);
  room.rematch = [false, false];
  room.busyUntil = 0;
}

function detach(socket) {
  const { code, seat } = socket.data;
  if (!code) return null;
  const room = rooms.get(code);
  socket.leave(code);
  socket.data.code = null; socket.data.seat = null;
  if (!room) return null;
  if (seat === -1) room.spectators.delete(socket.id);
  return room;
}

function attach(socket, room, name, clientId) {
  let seat = room.players.findIndex((p) => p && p.clientId === clientId);
  if (seat >= 0) {
    const p = room.players[seat];
    p.socketId = socket.id; p.connected = true; p.name = name; p.lastSeen = Date.now();
  } else {
    seat = room.players.findIndex((p) => !p);
    if (seat >= 0) {
      room.players[seat] = { clientId, name, socketId: socket.id, connected: true, lastSeen: Date.now() };
      if (room.players[0] && room.players[1]) startGame(room, true);
    } else {
      seat = -1;
      room.spectators.add(socket.id);
    }
  }
  socket.join(room.code);
  socket.data.code = room.code; socket.data.seat = seat;
  room.emptySince = 0;
  broadcastRoom(room);
  return seat;
}

io.on('connection', (socket) => {
  socket.data = { code: null, seat: null, clientId: null };
  let aimCount = 0;
  const aimReset = setInterval(() => { aimCount = 0; }, 1000);

  socket.on('create', (msg, ack) => {
    if (typeof ack !== 'function') return;
    msg = msg || {};
    const clientId = cleanId(msg.clientId) || socket.id;
    socket.data.clientId = clientId;
    const old = detach(socket); if (old) releaseSeatIfLeft(old, socket);
    const code = newCode();
    const room = {
      code, players: [null, null], spectators: new Set(), state: null, gameId: 0,
      rematch: [false, false], breaker: 0, busyUntil: 0, emptySince: 0, createdAt: Date.now(), score: [0, 0],
    };
    rooms.set(code, room);
    const seat = attach(socket, room, cleanName(msg.name), clientId);
    ack({ ok: true, code, seat });
  });

  socket.on('join', (msg, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    msg = msg || {};
    const code = String(msg.code || '').toUpperCase().slice(0, 4);
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: `There’s no room ${code || 'with that code'}. Check the code and try again.` });
    const clientId = cleanId(msg.clientId) || socket.id;
    socket.data.clientId = clientId;
    if (socket.data.code !== code) { const old = detach(socket); if (old) releaseSeatIfLeft(old, socket); }
    const seat = attach(socket, room, cleanName(msg.name), clientId);
    ack({ ok: true, code, seat });
  });

  socket.on('shoot', (raw) => {
    const room = rooms.get(socket.data.code);
    const seat = socket.data.seat;
    if (!room || !room.state || seat < 0) return;
    const st = room.state;
    if (st.phase === 'over') return socket.emit('shotRejected', 'The game is over.');
    if (st.turn !== seat) return socket.emit('shotRejected', 'It’s not your turn.');
    if (!room.players[0] || !room.players[1]) return socket.emit('shotRejected', 'Wait for your opponent to join.');
    if (Date.now() < room.busyUntil) return socket.emit('shotRejected', 'Wait for the balls to stop.');
    const res = Core.applyShot(st, raw);
    if (!res.ok) return socket.emit('shotRejected', res.error);
    room.state = res.state;
    room.busyUntil = Date.now() + res.steps * Core.DT * 1000 - 600;
    if (res.state.phase === 'over') { room.score[res.state.winner]++; room.breaker = 1 - room.breaker; }
    io.to(room.code).emit('shot', { gameId: room.gameId, start: st, input: res.input, result: res.state, score: room.score.slice() });
  });

  socket.on('aim', (a) => {
    const room = rooms.get(socket.data.code);
    if (!room || !room.state || room.state.turn !== socket.data.seat || ++aimCount > 40 || !a) return;
    socket.to(room.code).volatile.emit('aim', {
      dx: num(a.dx, -1, 1), dy: num(a.dy, -1, 1), power: num(a.power, 0, 1), spin: num(a.spin, -1, 1),
    });
  });

  socket.on('place', (p) => {
    const room = rooms.get(socket.data.code);
    if (!room || !room.state || room.state.turn !== socket.data.seat || !room.state.ballInHand || ++aimCount > 40 || !p) return;
    socket.to(room.code).volatile.emit('place', { x: num(p.x, 0, Core.W), y: num(p.y, 0, Core.H) });
  });

  socket.on('rematch', () => {
    const room = rooms.get(socket.data.code);
    const seat = socket.data.seat;
    if (!room || !room.state || room.state.phase !== 'over' || seat < 0) return;
    room.rematch[seat] = true;
    if (room.rematch[0] && room.rematch[1]) startGame(room);
    broadcastRoom(room);
  });

  socket.on('leave', () => {
    const room = detach(socket);
    if (room) releaseSeatIfLeft(room, socket, true);
  });

  socket.on('disconnect', () => {
    clearInterval(aimReset);
    const { code, seat } = socket.data;
    const room = rooms.get(code);
    if (!room) return;
    if (seat === -1) room.spectators.delete(socket.id);
    else if (seat >= 0) {
      const p = room.players[seat];
      if (p && p.socketId === socket.id) { p.connected = false; p.lastSeen = Date.now(); }
    }
    broadcastRoom(room);
  });
});

// A player who leaves on purpose gives up their seat straight away.
function releaseSeatIfLeft(room, socket, explicit) {
  const idx = room.players.findIndex((p) => p && p.socketId === socket.id);
  if (idx >= 0) {
    if (explicit) { room.players[idx] = null; room.state = null; room.rematch = [false, false]; }
    else { room.players[idx].connected = false; room.players[idx].lastSeen = Date.now(); }
  }
  if (!room.players[0] && !room.players[1] && room.spectators.size === 0) { rooms.delete(room.code); return; }
  broadcastRoom(room);
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    let changed = false;
    room.players.forEach((p, i) => {
      if (p && !p.connected && now - p.lastSeen > SEAT_GRACE_MS) { room.players[i] = null; room.state = null; changed = true; }
    });
    const anyone = room.players.some((p) => p && p.connected) || room.spectators.size > 0;
    if (!anyone) {
      if (!room.emptySince) room.emptySince = now;
      if (now - room.emptySince > ROOM_IDLE_MS) { rooms.delete(room.code); continue; }
    } else room.emptySince = 0;
    if (changed) broadcastRoom(room);
  }
}, 15000);

server.listen(PORT, () => console.log(`Pool server listening on :${PORT}`));
