(() => {
  'use strict';
  const C = window.PoolCore;
  const { W, H, R, POCKETS, BOUNDARY, HEAD_X, FOOT_X } = C;
  const PAD = 50;
  const WORLD_W = W + PAD * 2, WORLD_H = H + PAD * 2;
  const COLORS = { 1: '#f2b705', 2: '#1d4fa8', 3: '#c8102e', 4: '#5b2a86', 5: '#ee6c1b', 6: '#0f7a3d', 7: '#7b2418', 8: '#151515' };
  const colorOf = (n) => COLORS[n > 8 ? n - 8 : n];
  const IVORY = '#f4efe4';

  const $ = (s) => document.querySelector(s);
  const screens = { lobby: $('#lobby'), waiting: $('#waiting'), game: $('#game') };
  let current = 'lobby';
  function show(name) {
    current = name;
    for (const k in screens) screens[k].classList.toggle('active', k === name);
    if (name === 'game') requestAnimationFrame(() => tableR.resize());
    if (name === 'lobby') requestAnimationFrame(() => drawHero());
  }

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };
  // one id per browser tab, so a reload keeps your seat but a second tab is a new player
  let clientId = null;
  try { clientId = sessionStorage.getItem('pool.cid'); } catch (e) { /* ignore */ }
  if (!clientId) {
    clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem('pool.cid', clientId); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ state
  const app = {
    mode: null, seat: 0, code: null, players: [null, null], rematch: [false, false], gameId: 0,
    localNames: ['Player 1', 'Player 2'],
    state: null, anim: null, pending: false, pendingTimer: 0,
    aim: { dx: 1, dy: 0 }, power: 0, spin: 0, charging: false,
    place: null, drag: null,
    remote: { aim: null, place: null },
    strike: null, potAnims: [], online: false,
    aimDirty: false, placeDirty: false, lastSend: 0,
  };

  const myName = () => ($('#name').value.trim().slice(0, 16) || 'Player');
  function seatName(seat) {
    if (app.mode === 'local') return app.localNames[seat];
    const p = app.players[seat];
    return p ? p.name : 'Waiting…';
  }
  function who(seat) { // "You" for me online, otherwise the name
    return app.mode === 'online' && seat === app.seat ? 'You' : seatName(seat);
  }
  function bothHere() { return app.mode === 'local' || (app.players[0] && app.players[1]); }
  function myTurn() {
    const s = app.state;
    return !!s && s.phase !== 'over' && (app.mode === 'local' || s.turn === app.seat);
  }
  function canAct() { return myTurn() && !app.anim && !app.pending && bothHere() && (app.mode === 'local' || app.online); }
  function cueBall(st) { return (st || app.state).balls.find((b) => b.n === 0); }
  function cuePos() {
    const s = app.state;
    if (s.ballInHand) {
      if (myTurn() && app.place) return app.place;
      if (!myTurn() && app.remote.place) return app.remote.place;
    }
    const c = cueBall(s);
    return { x: c.x, y: c.y };
  }

  // ------------------------------------------------------------------ renderer
  function makeRenderer(canvas) {
    const r = { canvas, ctx: canvas.getContext('2d'), scale: 1, ox: 0, oy: 0, dpr: 1, layer: null, sprites: {}, shadow: null, w: 0, h: 0 };
    r.resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      r.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      r.w = rect.width; r.h = rect.height;
      canvas.width = Math.round(rect.width * r.dpr);
      canvas.height = Math.round(rect.height * r.dpr);
      // phones held upright get the table stood on its end
      r.rot = r.allowRotate && rect.height > rect.width * 1.15;
      const vw = r.rot ? WORLD_H : WORLD_W, vh = r.rot ? WORLD_W : WORLD_H;
      r.scale = Math.min(rect.width / vw, rect.height / vh);
      r.ox = (rect.width - vw * r.scale) / 2;
      r.oy = (rect.height - vh * r.scale) / 2;
      buildLayer(r); buildSprites(r);
    };
    r.toWorld = (cx, cy) => {
      const rect = canvas.getBoundingClientRect();
      const sx = (cx - rect.left - r.ox) / r.scale, sy = (cy - rect.top - r.oy) / r.scale;
      return r.rot ? { x: sy - PAD, y: WORLD_H - PAD - sx } : { x: sx - PAD, y: sy - PAD };
    };
    r.toScreen = (x, y) => { // CSS pixels relative to the canvas
      return r.rot ? { x: r.ox + (WORLD_H - PAD - y) * r.scale, y: r.oy + (x + PAD) * r.scale }
        : { x: r.ox + (x + PAD) * r.scale, y: r.oy + (y + PAD) * r.scale };
    };
    r.matrix = () => {
      const k = r.dpr * r.scale;
      return r.rot ? [0, k, -k, 0, r.dpr * (r.ox + (WORLD_H - PAD) * r.scale), r.dpr * (r.oy + PAD * r.scale)]
        : [k, 0, 0, k, r.dpr * (r.ox + PAD * r.scale), r.dpr * (r.oy + PAD * r.scale)];
    };
    r.worldTransform = () => r.ctx.setTransform(...r.matrix());
    return r;
  }
  const capture = (el, id) => { try { el.setPointerCapture(id); } catch (e) { /* pointer already gone */ } };

  function roundRect(ctx, x, y, w, h, rad) {
    ctx.beginPath();
    ctx.moveTo(x + rad, y); ctx.arcTo(x + w, y, x + w, y + h, rad); ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad); ctx.arcTo(x, y, x + w, y, rad); ctx.closePath();
  }

  function buildLayer(r) {
    const cv = document.createElement('canvas');
    cv.width = r.canvas.width; cv.height = r.canvas.height;
    const ctx = cv.getContext('2d');
    const k = r.dpr * r.scale;
    ctx.setTransform(...r.matrix());

    // drop shadow under the whole table
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 40 * k;
    if (r.rot) ctx.shadowOffsetX = 14 * k; else ctx.shadowOffsetY = 14 * k;
    roundRect(ctx, -PAD, -PAD, WORLD_W, WORLD_H, 30); ctx.fillStyle = '#3a2212'; ctx.fill();
    ctx.restore();

    // walnut rails
    const wood = ctx.createLinearGradient(0, -PAD, 0, H + PAD);
    wood.addColorStop(0, '#6e4526'); wood.addColorStop(0.08, '#56341b'); wood.addColorStop(0.5, '#4a2c17');
    wood.addColorStop(0.92, '#3d2312'); wood.addColorStop(1, '#2e1a0d');
    roundRect(ctx, -PAD, -PAD, WORLD_W, WORLD_H, 30); ctx.fillStyle = wood; ctx.fill();
    // grain
    ctx.save(); roundRect(ctx, -PAD, -PAD, WORLD_W, WORLD_H, 30); ctx.clip();
    let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 70; i++) {
      const y = -PAD + rnd() * WORLD_H;
      ctx.strokeStyle = `rgba(${rnd() < 0.5 ? '20,10,4' : '140,95,55'},${0.05 + rnd() * 0.08})`;
      ctx.lineWidth = 0.6 + rnd() * 1.6;
      ctx.beginPath(); ctx.moveTo(-PAD, y);
      ctx.bezierCurveTo(W * 0.3, y + (rnd() - 0.5) * 18, W * 0.7, y + (rnd() - 0.5) * 18, W + PAD, y + (rnd() - 0.5) * 10);
      ctx.stroke();
    }
    ctx.restore();
    roundRect(ctx, -PAD + 1.5, -PAD + 1.5, WORLD_W - 3, WORLD_H - 3, 29);
    ctx.strokeStyle = 'rgba(255,220,170,0.18)'; ctx.lineWidth = 1.5; ctx.stroke();

    // cushion rubber
    roundRect(ctx, -24, -24, W + 48, H + 48, 6); ctx.fillStyle = '#135337'; ctx.fill();

    // felt (play area + pocket channels), lit by the lamp
    ctx.beginPath();
    BOUNDARY.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    const felt = ctx.createRadialGradient(W / 2, H / 2, 20, W / 2, H / 2, W * 0.62);
    felt.addColorStop(0, '#2b9466'); felt.addColorStop(0.55, '#1f7a54'); felt.addColorStop(1, '#155a3e');
    ctx.fillStyle = felt; ctx.fill();
    ctx.save(); ctx.clip();
    // cushion shadow on the felt
    ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 8; ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1.2; ctx.stroke();

    // markings
    ctx.strokeStyle = 'rgba(255,255,255,0.13)'; ctx.lineWidth = 1.2; ctx.setLineDash([6, 7]);
    ctx.beginPath(); ctx.moveTo(HEAD_X, 6); ctx.lineTo(HEAD_X, H - 6); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    for (const x of [HEAD_X, FOOT_X]) { ctx.beginPath(); ctx.arc(x, H / 2, 2.2, 0, Math.PI * 2); ctx.fill(); }

    // pockets with brass caps
    ctx.save();
    ctx.beginPath(); ctx.rect(-PAD, -PAD, WORLD_W, WORLD_H); roundRect(ctx, -24, -24, W + 48, H + 48, 6);
    ctx.clip('evenodd');
    for (const p of POCKETS) {
      const g = ctx.createLinearGradient(p.x - 30, p.y - 30, p.x + 30, p.y + 30);
      g.addColorStop(0, '#f0d79a'); g.addColorStop(0.5, '#b88f45'); g.addColorStop(1, '#7c5a24');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 11, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    for (const p of POCKETS) {
      const g = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, p.r + 3);
      g.addColorStop(0, '#000'); g.addColorStop(0.75, '#0b0806'); g.addColorStop(1, '#2a1d14');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 3, 0, Math.PI * 2); ctx.fill();
    }

    // diamonds
    ctx.fillStyle = '#e9dcbf';
    const diamond = (x, y) => { ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 3, y); ctx.lineTo(x, y + 4); ctx.lineTo(x - 3, y); ctx.closePath(); ctx.fill(); };
    for (let i = 1; i < 8; i++) { if (i === 4) continue; diamond(W * i / 8, -37); diamond(W * i / 8, H + 37); }
    for (let i = 1; i < 4; i++) { diamond(-37, H * i / 4); diamond(W + 37, H * i / 4); }
    r.layer = cv;
  }

  function buildSprites(r) {
    const k = r.dpr * r.scale, size = Math.ceil((2 * R + 2) * k);
    const draw = (n) => {
      const cv = document.createElement('canvas'); cv.width = cv.height = size;
      const ctx = cv.getContext('2d');
      ctx.setTransform(k, 0, 0, k, size / 2, size / 2);
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fillStyle = n === 0 ? '#f6f2e8' : (n > 8 ? IVORY : colorOf(n)); ctx.fill();
      if (n > 8) {
        ctx.save(); ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.clip();
        ctx.fillStyle = colorOf(n); ctx.fillRect(-R, -R * 0.56, 2 * R, R * 1.12); ctx.restore();
      }
      if (n > 0) {
        ctx.beginPath(); ctx.arc(0, 0, R * 0.47, 0, Math.PI * 2); ctx.fillStyle = IVORY; ctx.fill();
        ctx.fillStyle = '#141414';
        ctx.font = `700 ${n > 9 ? R * 0.56 : R * 0.64}px Barlow, system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(n), 0, R * 0.04);
      }
      const sh = ctx.createRadialGradient(-R * 0.35, -R * 0.42, 0, 0, 0, R);
      sh.addColorStop(0, 'rgba(255,255,255,0.75)'); sh.addColorStop(0.18, 'rgba(255,255,255,0.18)');
      sh.addColorStop(0.5, 'rgba(255,255,255,0)'); sh.addColorStop(0.82, 'rgba(0,0,0,0.12)'); sh.addColorStop(1, 'rgba(0,0,0,0.42)');
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fillStyle = sh; ctx.fill();
      return cv;
    };
    for (let n = 0; n <= 15; n++) r.sprites[n] = draw(n);
    const scv = document.createElement('canvas'); scv.width = scv.height = Math.ceil(R * 3 * k);
    const sctx = scv.getContext('2d');
    const g = sctx.createRadialGradient(scv.width / 2, scv.height / 2, 0, scv.width / 2, scv.height / 2, scv.width / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.5)'); g.addColorStop(0.55, 'rgba(0,0,0,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    sctx.fillStyle = g; sctx.fillRect(0, 0, scv.width, scv.height);
    r.shadow = scv;
  }

  function drawBall(r, n, x, y, scale, alpha) {
    const ctx = r.ctx, s = (2 * R + 2) * (scale || 1);
    if (alpha !== undefined) ctx.globalAlpha = alpha;
    if (r.rot) { // keep the numbers upright on screen
      ctx.save(); ctx.translate(x, y); ctx.rotate(-Math.PI / 2); ctx.drawImage(r.sprites[n], -s / 2, -s / 2, s, s); ctx.restore();
    } else ctx.drawImage(r.sprites[n], x - s / 2, y - s / 2, s, s);
    ctx.globalAlpha = 1;
  }
  function drawShadow(r, x, y) {
    // the lamp hangs over the middle, so shadows fall away from it
    const sx = x + (x - W / 2) * 0.012 + 1.5, sy = y + (y - H / 2) * 0.02 + 3, s = R * 3;
    r.ctx.drawImage(r.shadow, sx - s / 2, sy - s / 2, s, s);
  }

  function drawCue(r, cx, cy, dx, dy, gap, alpha) {
    const ctx = r.ctx;
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.translate(cx, cy); ctx.rotate(Math.atan2(dy, dx));
    const L = 620, x0 = -gap, x1 = -gap - L;
    const w0 = 2.6, w1 = 6;
    const shaft = (a, b, colA) => {
      const t0 = (x0 - a) / L, t1 = (x0 - b) / L;
      const wa = w0 + (w1 - w0) * t0, wb = w0 + (w1 - w0) * t1;
      ctx.beginPath(); ctx.moveTo(a, -wa); ctx.lineTo(b, -wb); ctx.lineTo(b, wb); ctx.lineTo(a, wa); ctx.closePath();
      ctx.fillStyle = colA; ctx.fill();
    };
    ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 6;
    const maple = ctx.createLinearGradient(0, -6, 0, 6);
    maple.addColorStop(0, '#f1d9a8'); maple.addColorStop(0.5, '#d9b57a'); maple.addColorStop(1, '#a8834e');
    shaft(x0 - 9, x0 - 360, maple);
    ctx.shadowColor = 'transparent';
    const butt = ctx.createLinearGradient(0, -6, 0, 6);
    butt.addColorStop(0, '#5a3020'); butt.addColorStop(0.5, '#2d140b'); butt.addColorStop(1, '#170905');
    shaft(x0 - 360, x1, butt);
    shaft(x0 - 356, x0 - 364, '#d3af66');
    shaft(x0 - 2.5, x0 - 9, '#efe8da');
    shaft(x0, x0 - 2.5, '#4a8fc4');
    ctx.restore();
  }

  function computeGuide(cx, cy, dx, dy, balls) {
    let best = Infinity, hit = null;
    for (const b of balls) {
      if (b.in || b.n === 0) continue;
      const fx = cx - b.x, fy = cy - b.y, bb = fx * dx + fy * dy, cc = fx * fx + fy * fy - 4 * R * R;
      const disc = bb * bb - cc;
      if (disc < 0) continue;
      const t = -bb - Math.sqrt(disc);
      if (t > -0.5 && t < best) { best = Math.max(0, t); hit = b; }
    }
    let tx = Infinity, ty = Infinity;
    if (dx > 1e-9) tx = (W - R - cx) / dx; else if (dx < -1e-9) tx = (R - cx) / dx;
    if (dy > 1e-9) ty = (H - R - cy) / dy; else if (dy < -1e-9) ty = (R - cy) / dy;
    const tr = Math.max(0, Math.min(tx, ty));
    if (hit && best <= tr) {
      const gx = cx + dx * best, gy = cy + dy * best;
      let nx = hit.x - gx, ny = hit.y - gy; const nl = Math.sqrt(nx * nx + ny * ny) || 1; nx /= nl; ny /= nl;
      const cos = dx * nx + dy * ny;
      let px = dx - cos * nx, py = dy - cos * ny; const pl = Math.sqrt(px * px + py * py) || 1; px /= pl; py /= pl;
      return { type: 'ball', gx, gy, hit, nx, ny, cos, px, py };
    }
    const ex = cx + dx * tr, ey = cy + dy * tr;
    return { type: 'rail', gx: ex, gy: ey, rdx: tx < ty ? -dx : dx, rdy: tx < ty ? dy : -dy };
  }

  function drawGuide(r, cx, cy, dx, dy, balls, alpha) {
    const ctx = r.ctx, g = computeGuide(cx, cy, dx, dy, balls);
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.4; ctx.setLineDash([7, 6]);
    ctx.beginPath(); ctx.moveTo(cx + dx * R, cy + dy * R); ctx.lineTo(g.gx - dx * (g.type === 'ball' ? R : 0), g.gy - dy * (g.type === 'ball' ? R : 0)); ctx.stroke();
    ctx.setLineDash([]);
    if (g.type === 'ball') {
      ctx.beginPath(); ctx.arc(g.gx, g.gy, R, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1.4; ctx.stroke();
      const L = 110;
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath(); ctx.moveTo(g.hit.x + g.nx * R, g.hit.y + g.ny * R); ctx.lineTo(g.hit.x + g.nx * (R + L * g.cos), g.hit.y + g.ny * (R + L * g.cos)); ctx.stroke();
      const s = Math.sqrt(Math.max(0, 1 - g.cos * g.cos));
      ctx.strokeStyle = 'rgba(160,210,240,0.55)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(g.gx + g.px * R, g.gy + g.py * R); ctx.lineTo(g.gx + g.px * (R + L * 0.7 * s), g.gy + g.py * (R + L * 0.7 * s)); ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.setLineDash([3, 6]);
      ctx.beginPath(); ctx.moveTo(g.gx, g.gy); ctx.lineTo(g.gx + g.rdx * 70, g.gy + g.rdy * 70); ctx.stroke();
    }
    ctx.restore();
  }

  function render(r, now) {
    const ctx = r.ctx, s = app.state;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, r.canvas.width, r.canvas.height);
    if (!r.layer) return;
    ctx.drawImage(r.layer, 0, 0);
    if (!s) return;
    r.worldTransform();

    const anim = app.anim;
    const balls = (anim ? anim.sim.balls : s.balls).filter((b) => !b.in);
    const cp = anim ? null : cuePos();
    const placing = !anim && s.ballInHand && s.phase !== 'over';

    // kitchen hint while placing behind the line
    if (placing && s.kitchen && (myTurn() || app.remote.place)) {
      ctx.fillStyle = 'rgba(255,255,255,0.035)'; ctx.fillRect(0, 0, HEAD_X, H);
    }
    for (const b of balls) {
      const p = (b.n === 0 && cp) ? cp : b;
      drawShadow(r, p.x, p.y);
    }
    for (const b of balls) {
      const p = (b.n === 0 && cp) ? cp : b;
      drawBall(r, b.n, p.x, p.y);
    }
    // balls dropping into pockets
    app.potAnims = app.potAnims.filter((a) => now - a.t0 < 0.24);
    for (const a of app.potAnims) {
      const t = (now - a.t0) / 0.24, pk = POCKETS[a.p];
      drawBall(r, a.n, a.x + (pk.x - a.x) * t, a.y + (pk.y - a.y) * t, 1 - 0.4 * t, 1 - t);
    }

    if (placing && cp) {
      const mine = myTurn();
      ctx.save(); ctx.setLineDash([4, 5]); ctx.lineWidth = 1.5;
      ctx.strokeStyle = mine ? 'rgba(99,174,219,0.95)' : 'rgba(255,255,255,0.5)';
      ctx.beginPath(); ctx.arc(cp.x, cp.y, R + 6, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }

    // cue and guide
    if (!anim && s.phase !== 'over' && cp && bothHere()) {
      if (myTurn() && !app.pending) {
        if (!(app.drag && app.drag.kind === 'place')) {
          drawGuide(r, cp.x, cp.y, app.aim.dx, app.aim.dy, s.balls, 1);
          drawCue(r, cp.x, cp.y, app.aim.dx, app.aim.dy, R + 4 + app.power * 80, 1);
        }
      } else if (!myTurn() && app.remote.aim) {
        const a = app.remote.aim;
        drawGuide(r, cp.x, cp.y, a.dx, a.dy, s.balls, 0.5);
        drawCue(r, cp.x, cp.y, a.dx, a.dy, R + 4 + a.power * 80, 0.85);
      }
    }
    // the stroke itself
    const st = app.strike;
    if (st) {
      const t = now - st.t0;
      let gap, alpha = 1;
      if (t < 0.09) gap = R + 4 + st.power * 80 * (1 - t / 0.09);
      else if (!st.hitAt) gap = R + 1;
      else { const u = Math.min(1, (t - st.hitAt) / 0.35); gap = R + 1 - 10 * u; alpha = 1 - u; if (u >= 1) app.strike = null; }
      if (app.strike) drawCue(r, st.x, st.y, st.dx, st.dy, gap, alpha);
    }
  }

  // ------------------------------------------------------------------ audio
  const audio = {
    ctx: null, noise: null, master: null, on: store.get('pool.sound') !== 'off', budget: 0,
    unlock() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        const len = Math.floor(this.ctx.sampleRate * 0.4), buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.noise = buf;
        this.master = this.ctx.createGain(); this.master.gain.value = 0.7; this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    },
    play(kind, vol) {
      if (!this.on || !this.ctx || this.ctx.state !== 'running' || this.budget <= 0) return;
      this.budget--;
      vol = Math.max(0.03, Math.min(1, vol));
      const c = this.ctx, t = c.currentTime;
      const env = (node, peak, decay) => {
        const g = c.createGain(); g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(peak, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
        node.connect(g); g.connect(this.master); return g;
      };
      const noise = (type, freq, q, peak, decay) => {
        const src = c.createBufferSource(); src.buffer = this.noise;
        const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
        src.connect(f); env(f, peak, decay); src.start(t, Math.random() * 0.2, decay + 0.05);
      };
      const tone = (f0, f1, peak, decay) => {
        const o = c.createOscillator(); o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + decay);
        env(o, peak, decay); o.start(t); o.stop(t + decay + 0.05);
      };
      if (kind === 'ball') { noise('bandpass', 3300, 1.4, 0.9 * vol, 0.05); tone(2100, 1800, 0.12 * vol, 0.035); }
      else if (kind === 'rail') { noise('lowpass', 520, 0.8, 0.8 * vol, 0.09); }
      else if (kind === 'pocket') { tone(140, 55, 0.5 * vol, 0.22); noise('lowpass', 380, 0.7, 0.5 * vol, 0.16); }
      else if (kind === 'cue') { noise('bandpass', 1700, 0.9, 0.8 * vol, 0.04); tone(700, 500, 0.1 * vol, 0.03); }
    },
  };

  // ------------------------------------------------------------------ shots
  function beginShot(start, input, result) {
    if (app.anim) finishShot();
    const now = performance.now() / 1000;
    if (!app.strike || app.strike.hitAt) {
      const c = input.cue || cueBall(start);
      app.strike = { t0: now, x: c.x, y: c.y, dx: input.dx, dy: input.dy, power: input.power };
    }
    const elapsed = now - app.strike.t0;
    app.anim = { sim: C.createSim(start, input), result, acc: 0, delay: Math.max(0, 0.09 - elapsed), ev: 0, played: false, power: input.power };
    app.pending = false; clearTimeout(app.pendingTimer);
    app.remote.aim = null; app.remote.place = null; app.power = 0; app.charging = false;
    updateHUD();
  }

  function stepAnim(dt, now) {
    const a = app.anim;
    if (a.delay > 0) { a.delay -= dt; if (a.delay > 0) return; dt = -a.delay; }
    if (!a.played) { a.played = true; audio.play('cue', 0.2 + a.power); if (app.strike) app.strike.hitAt = now - app.strike.t0; }
    a.acc += dt;
    let steps = Math.floor(a.acc / C.DT);
    a.acc -= steps * C.DT;
    while (steps-- > 0 && !a.sim.done) C.stepSim(a.sim);
    drainEvents(now);
    if (a.sim.done) finishShot();
  }

  function drainEvents(now) {
    const a = app.anim, ev = a.sim.events;
    for (; a.ev < ev.length; a.ev++) {
      const e = ev[a.ev];
      if (e.t === 'ball') audio.play('ball', e.s / 1400);
      else if (e.t === 'rail') audio.play('rail', e.s / 1600);
      else if (e.t === 'pocket') { audio.play('pocket', 0.8); app.potAnims.push({ n: e.n, x: e.x, y: e.y, p: e.p, t0: now }); }
    }
  }

  function finishShot() {
    const a = app.anim;
    if (!a) return;
    app.anim = null;
    setState(a.result, true);
  }

  function setState(st, afterShot) {
    app.state = st;
    const c = cueBall(st);
    app.place = st.ballInHand ? { x: c.x, y: c.y } : null;
    app.power = 0; app.spin = 0; app.charging = false;
    app.remote.place = null;
    if (st.shotNo === 0) app.aim = { dx: 1, dy: 0 };
    updateSpinDot();
    if (afterShot && st.lastShot) announce(st, st.lastShot);
    updateHUD();
    $('#over').hidden = st.phase !== 'over';
    if (st.phase === 'over') showOver();
  }

  function shoot() {
    if (!canAct()) return;
    const power = app.power;
    if (power < 0.02) { app.power = 0; return; }
    audio.unlock();
    const s = app.state;
    const input = { dx: app.aim.dx, dy: app.aim.dy, power, spin: app.spin, cue: s.ballInHand ? app.place : null };
    const c = input.cue || cueBall(s);
    app.strike = { t0: performance.now() / 1000, x: c.x, y: c.y, dx: input.dx, dy: input.dy, power };
    if (app.mode === 'local') {
      const res = C.applyShot(s, input);
      if (!res.ok) { app.strike = null; toast(res.error); return; }
      beginShot(s, res.input, res.state);
    } else {
      app.pending = true;
      socket.emit('shoot', input);
      clearTimeout(app.pendingTimer);
      app.pendingTimer = setTimeout(() => { if (app.pending) { app.pending = false; app.strike = null; toast('That shot didn’t reach the server. Try again.'); } }, 6000);
    }
    app.power = 0;
  }

  // ------------------------------------------------------------------ HUD
  function miniBall(n, gone) {
    const el = document.createElement('span');
    el.className = 'mb' + (gone ? ' gone' : '');
    const c = colorOf(n);
    el.style.background = n > 8 ? `linear-gradient(${IVORY} 0 27%, ${c} 27% 73%, ${IVORY} 73%)` : c;
    return el;
  }

  function updateHUD() {
    const s = app.state;
    for (let seat = 0; seat < 2; seat++) {
      const card = $('#p' + seat);
      const nameEl = card.querySelector('.pname');
      nameEl.textContent = seatName(seat);
      if (app.mode === 'online' && seat === app.seat) nameEl.textContent += ' (you)';
      const p = app.players[seat];
      if (app.mode === 'online' && p && !p.connected) {
        const off = document.createElement('span'); off.className = 'off'; off.textContent = 'offline'; nameEl.appendChild(off);
      }
      const ballsEl = card.querySelector('.pballs');
      ballsEl.textContent = '';
      if (s) {
        const g = s.groups[seat];
        if (!g) ballsEl.textContent = s.phase === 'break' ? '' : 'Open table';
        else {
          const nums = g === C.SOLIDS ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
          const left = nums.filter((n) => !s.balls.find((b) => b.n === n).in);
          for (const n of nums) ballsEl.appendChild(miniBall(n, s.balls.find((b) => b.n === n).in));
          if (!left.length) ballsEl.appendChild(miniBall(8, false));
        }
      }
      card.classList.toggle('active', !!s && s.phase !== 'over' && s.turn === seat);
    }
    const status = $('#status');
    status.textContent = statusText();
    const opp = app.mode === 'online' && app.seat >= 0 ? app.players[1 - app.seat] : null;
    if (app.mode === 'online' && (!app.online || (opp && !opp.connected))) {
      const w = document.createElement('div'); w.className = 'warn';
      w.textContent = !app.online ? 'Connection lost. Reconnecting…' : 'Your opponent dropped out. Waiting for them to come back…';
      status.appendChild(w);
    }
    $('.controls').classList.toggle('disabled', !canAct());
    $('#room-label').innerHTML = '';
    if (app.mode === 'online' && app.code) {
      $('#room-label').append('Room ');
      const b = document.createElement('b'); b.textContent = app.code; $('#room-label').append(b);
      if (app.seat < 0) $('#room-label').append(' · watching');
    }
    updatePowerBar();
  }

  function statusText() {
    const s = app.state;
    if (!s) return '';
    if (s.phase === 'over') return 'Game over';
    if (app.anim || app.pending) return '';
    const t = s.turn, mine = app.mode === 'online' && t === app.seat;
    const name = seatName(t);
    let txt;
    if (s.phase === 'break') txt = mine ? 'Your break' : `${name} to break`;
    else txt = mine ? 'Your shot' : `${name}’s shot`;
    if (s.ballInHand) txt += s.kitchen ? '. Place the cue ball behind the line' : '. Ball in hand: drag the cue ball anywhere';
    const g = s.groups[t];
    if (g && C.remaining(s, g) === 0) txt += '. On the 8';
    return txt;
  }

  function announce(st, shot) {
    if (st.phase === 'over') return;
    const by = who(shot.by), next = who(st.turn);
    const you = (n) => n === 'You';
    let msg = '';
    if (shot.foul) msg = `Foul: ${shot.foul.toLowerCase()}. ${next} ${you(next) ? 'have' : 'has'} ball in hand.`;
    else if (shot.assigned) msg = `${by} ${you(by) ? 'are' : 'is'} ${shot.assigned}.`;
    else if (shot.eightSpotted) msg = 'The 8 went down on the break, so it goes back on the spot.';
    else if (shot.potted.length && shot.continued) msg = `${by} potted ${shot.potted.length > 1 ? shot.potted.length + ' balls' : 'the ' + shot.potted[0]}. ${you(by) ? 'Go again.' : 'Still their shot.'}`;
    if (msg) toast(msg);
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function showOver() {
    const s = app.state, shot = s.lastShot || {};
    const winner = s.winner;
    const title = app.mode === 'online'
      ? (winner === app.seat ? 'You win' : (app.seat < 0 ? `${seatName(winner)} wins` : 'You lose'))
      : `${seatName(winner)} wins`;
    $('#over-title').textContent = title;
    const by = who(shot.by);
    $('#over-reason').textContent = shot.reason ? `${by} ${shot.reason.charAt(0).toLowerCase() + shot.reason.slice(1)}.` : '';
    const btn = $('#btn-rematch'), note = $('#over-note');
    btn.hidden = app.mode === 'online' && app.seat < 0;
    if (app.mode === 'local') { btn.textContent = 'Play again'; btn.disabled = false; note.textContent = ''; }
    else {
      const mine = app.rematch[app.seat], theirs = app.rematch[1 - app.seat];
      btn.textContent = mine ? 'Waiting for opponent…' : 'Rematch';
      btn.disabled = !!mine;
      note.textContent = theirs && !mine ? `${seatName(1 - app.seat)} wants a rematch.` : '';
    }
  }

  // ------------------------------------------------------------------ controls
  const tableR = makeRenderer($('#table'));
  tableR.allowRotate = true;
  const heroR = makeRenderer($('#hero'));
  const canvas = $('#table');

  function setAimToward(x, y) {
    const c = cuePos();
    const dx = x - c.x, dy = y - c.y, l = Math.sqrt(dx * dx + dy * dy);
    if (l < 2) return;
    app.aim = { dx: dx / l, dy: dy / l }; app.aimDirty = true;
  }
  function rotateAim(delta) {
    const a = Math.atan2(app.aim.dy, app.aim.dx) + delta;
    app.aim = { dx: Math.cos(a), dy: Math.sin(a) }; app.aimDirty = true;
  }
  function tryPlace(p) {
    const s = app.state;
    let x = Math.min(W - R, Math.max(R, p.x)), y = Math.min(H - R, Math.max(R, p.y));
    if (s.kitchen) x = Math.min(x, HEAD_X);
    if (C.placementOk(s.balls, x, y, s.kitchen)) { app.place = { x, y }; app.placeDirty = true; }
  }

  canvas.addEventListener('pointerdown', (e) => {
    audio.unlock();
    if (!canAct()) return;
    const p = tableR.toWorld(e.clientX, e.clientY), c = cuePos(), s = app.state;
    const d = Math.sqrt((p.x - c.x) * (p.x - c.x) + (p.y - c.y) * (p.y - c.y));
    capture(canvas, e.pointerId);
    if (s.ballInHand && d < R * 2.6) app.drag = { kind: 'place', id: e.pointerId };
    else if (!s.ballInHand && d < R * 3) app.drag = { kind: 'pull', id: e.pointerId };
    else { app.drag = { kind: 'aim', id: e.pointerId }; setAimToward(p.x, p.y); }
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    const dr = app.drag;
    if (!dr || dr.id !== e.pointerId || !canAct()) return;
    const p = tableR.toWorld(e.clientX, e.clientY);
    if (dr.kind === 'place') tryPlace(p);
    else if (dr.kind === 'aim') setAimToward(p.x, p.y);
    else if (dr.kind === 'pull') {
      const c = cuePos(), vx = p.x - c.x, vy = p.y - c.y, l = Math.sqrt(vx * vx + vy * vy);
      if (l > R) { app.aim = { dx: -vx / l, dy: -vy / l }; app.aimDirty = true; }
      app.power = Math.max(0, Math.min(1, (l - R * 1.5) / 260));
    }
  });
  const endCanvasDrag = (e) => {
    const dr = app.drag;
    if (!dr || dr.id !== e.pointerId) return;
    app.drag = null;
    if (dr.kind === 'pull') { if (e.type === 'pointerup') shoot(); else app.power = 0; }
    if (dr.kind === 'place') app.placeDirty = true;
  };
  canvas.addEventListener('pointerup', endCanvasDrag);
  canvas.addEventListener('pointercancel', endCanvasDrag);

  // power bar
  const powerEl = $('#power'), track = powerEl.querySelector('.power-track'), fill = powerEl.querySelector('.power-fill');
  function powerFrom(e) {
    const r = track.getBoundingClientRect();
    const v = r.height >= r.width ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    return Math.max(0, Math.min(1, v));
  }
  let powerDrag = null;
  powerEl.addEventListener('pointerdown', (e) => {
    audio.unlock();
    if (!canAct()) return;
    capture(powerEl, e.pointerId);
    powerDrag = { id: e.pointerId, start: powerFrom(e) };
    app.power = 0; app.aimDirty = true; e.preventDefault();
  });
  powerEl.addEventListener('pointermove', (e) => {
    if (!powerDrag || powerDrag.id !== e.pointerId) return;
    app.power = Math.max(0, Math.min(1, powerFrom(e) - powerDrag.start));
    app.aimDirty = true;
  });
  const endPower = (e) => {
    if (!powerDrag || powerDrag.id !== e.pointerId) return;
    powerDrag = null;
    if (e.type === 'pointerup') shoot(); else app.power = 0;
  };
  powerEl.addEventListener('pointerup', endPower);
  powerEl.addEventListener('pointercancel', endPower);
  function updatePowerBar() {
    const r = track.getBoundingClientRect(), pct = (app.power * 100).toFixed(1) + '%';
    if (r.height >= r.width) { fill.style.height = pct; fill.style.width = ''; }
    else { fill.style.width = pct; fill.style.height = ''; }
  }

  // spin
  const spinEl = $('#spin'), dot = spinEl.querySelector('.spin-dot');
  function updateSpinDot() { dot.style.top = (50 - app.spin * 36) + '%'; }
  function spinFrom(e) {
    const r = spinEl.getBoundingClientRect();
    app.spin = Math.max(-1, Math.min(1, -((e.clientY - r.top) / r.height - 0.5) / 0.36));
    if (Math.abs(app.spin) < 0.12) app.spin = 0;
    updateSpinDot(); app.aimDirty = true;
  }
  let spinDrag = null;
  spinEl.addEventListener('pointerdown', (e) => { if (!canAct()) return; spinDrag = e.pointerId; capture(spinEl, e.pointerId); spinFrom(e); });
  spinEl.addEventListener('pointermove', (e) => { if (spinDrag === e.pointerId) spinFrom(e); });
  spinEl.addEventListener('pointerup', () => { spinDrag = null; });
  spinEl.addEventListener('dblclick', () => { app.spin = 0; updateSpinDot(); });

  // fine aim buttons (hold to repeat)
  for (const [id, dir] of [['#aim-l', -1], ['#aim-r', 1]]) {
    const b = $(id); let timer = 0, held = 0;
    const stop = () => { clearInterval(timer); timer = 0; };
    b.addEventListener('pointerdown', (e) => {
      if (!canAct()) return;
      e.preventDefault(); held = 0; rotateAim(dir * 0.0015);
      stop(); timer = setInterval(() => { held++; rotateAim(dir * (held > 30 ? 0.006 : 0.0015)); }, 30);
    });
    b.addEventListener('pointerup', stop); b.addEventListener('pointerleave', stop); b.addEventListener('pointercancel', stop);
  }

  // keyboard
  window.addEventListener('keydown', (e) => {
    if (current !== 'game' || e.target.tagName === 'INPUT') return;
    if (!canAct()) return;
    const fine = e.shiftKey ? 0.012 : 0.002;
    if (e.key === 'ArrowLeft') { rotateAim(-fine); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { rotateAim(fine); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { app.spin = Math.min(1, app.spin + 0.25); updateSpinDot(); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { app.spin = Math.max(-1, app.spin - 0.25); updateSpinDot(); e.preventDefault(); }
    else if (e.code === 'Space' && !e.repeat) { audio.unlock(); app.charging = true; app.power = 0; e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && app.charging) { app.charging = false; shoot(); e.preventDefault(); }
  });

  // ------------------------------------------------------------------ networking
  let socket = null;
  function ensureSocket() {
    if (socket) return socket;
    if (typeof window.io !== 'function') return null;
    socket = window.io({ transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      app.online = true;
      if (app.mode === 'online' && app.code) socket.emit('join', { code: app.code, name: myName(), clientId }, () => {});
      updateHUD();
    });
    socket.on('disconnect', () => { app.online = false; app.pending = false; updateHUD(); });
    socket.on('room', onRoom);
    socket.on('shot', (m) => {
      if (app.mode !== 'online' || m.gameId !== app.gameId) return;
      beginShot(m.start, m.input, m.result);
    });
    socket.on('aim', (a) => { if (app.state && !myTurn()) app.remote.aim = a; });
    socket.on('place', (p) => { if (app.state && !myTurn()) app.remote.place = p; });
    socket.on('shotRejected', (msg) => { app.pending = false; app.strike = null; toast(String(msg)); updateHUD(); });
    socket.on('kicked', (msg) => { leaveToLobby(String(msg)); });
    return socket;
  }

  function onRoom(r) {
    if (app.mode !== 'online') return;
    app.code = r.code; app.seat = r.you; app.players = r.players; app.rematch = r.rematch;
    const url = new URL(location.href); url.searchParams.set('room', r.code);
    history.replaceState(null, '', url);
    const full = r.players[0] && r.players[1];
    if (r.state && full) {
      const sameGame = r.gameId === app.gameId;
      app.gameId = r.gameId;
      if (current !== 'game') show('game');
      if (app.anim && sameGame && r.state.shotNo === app.anim.result.shotNo) app.anim.result = r.state;
      else if (app.anim) { app.anim = null; setState(r.state, false); }
      else if (!sameGame || !app.state || r.state.shotNo !== app.state.shotNo) setState(r.state, false);
      else if (r.state.phase === 'over') showOver();
      updateHUD();
    } else {
      app.state = null; app.anim = null;
      $('#over').hidden = true;
      $('#room-code').textContent = r.code;
      const other = app.seat >= 0 ? r.players[1 - app.seat] : null;
      $('#wait-msg').textContent = app.seat < 0 ? 'Waiting for the game to start…'
        : (app.gameId ? 'Your opponent left. Waiting for someone to join…' : 'Waiting for your opponent…');
      if (other) $('#wait-msg').textContent = `${other.name} is here.`;
      show('waiting');
    }
  }

  function goOnline(action, code) {
    const err = $('#lobby-error'); err.textContent = '';
    const name = myName(); store.set('pool.name', name);
    const s = ensureSocket();
    if (!s) { err.textContent = 'Online play needs the game server. Open the game from its web address.'; return; }
    const btns = document.querySelectorAll('#lobby .btn'); btns.forEach((b) => (b.disabled = true));
    const done = () => btns.forEach((b) => (b.disabled = false));
    const timer = setTimeout(() => { done(); err.textContent = 'The server is taking a while to wake up. Try again in a few seconds.'; }, 20000);
    const ack = (res) => {
      clearTimeout(timer); done();
      if (!res || !res.ok) { app.mode = null; err.textContent = (res && res.error) || 'Something went wrong. Try again.'; return; }
      app.code = res.code;
      try { sessionStorage.setItem('pool.room', res.code); } catch (e) { /* ignore */ }
    };
    app.mode = 'online'; app.gameId = 0; app.state = null;
    if (action === 'create') s.emit('create', { name, clientId }, ack);
    else s.emit('join', { code, name, clientId }, ack);
  }

  function leaveToLobby(msg) {
    if (app.mode === 'online' && socket) socket.emit('leave');
    app.mode = null; app.code = null; app.state = null; app.anim = null; app.gameId = 0; app.pending = false;
    try { sessionStorage.removeItem('pool.room'); } catch (e) { /* ignore */ }
    $('#over').hidden = true;
    const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState(null, '', url);
    $('#lobby-error').textContent = msg || '';
    show('lobby');
  }

  function startLocal() {
    audio.unlock();
    store.set('pool.name', myName());
    app.mode = 'local'; app.localNames = [myName(), 'Player 2']; app.seat = 0;
    app.localBreaker = 0;
    show('game');
    setState(C.newGame(0), false);
  }

  // ------------------------------------------------------------------ buttons
  $('#btn-create').addEventListener('click', () => { audio.unlock(); goOnline('create'); });
  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault(); audio.unlock();
    const code = $('#code').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) { $('#lobby-error').textContent = 'Room codes are 4 letters.'; return; }
    goOnline('join', code);
  });
  $('#code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
  $('#btn-local').addEventListener('click', startLocal);
  $('#btn-cancel').addEventListener('click', () => leaveToLobby());
  $('#btn-leave').addEventListener('click', () => leaveToLobby());
  $('#btn-over-leave').addEventListener('click', () => leaveToLobby());
  $('#btn-copy').addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}?room=${app.code}`;
    const btn = $('#btn-copy');
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Play pool with me', text: `Room code ${app.code}`, url: link });
      else { await navigator.clipboard.writeText(link); btn.textContent = 'Link copied'; setTimeout(() => (btn.textContent = 'Copy invite link'), 1800); }
    } catch (e) { btn.textContent = link; }
  });
  $('#btn-rematch').addEventListener('click', () => {
    if (app.mode === 'local') {
      app.localBreaker = 1 - (app.localBreaker || 0);
      $('#over').hidden = true;
      setState(C.newGame(app.localBreaker), false);
    } else if (socket) { socket.emit('rematch'); $('#btn-rematch').disabled = true; $('#btn-rematch').textContent = 'Waiting for opponent…'; }
  });
  $('#btn-help').addEventListener('click', () => { $('#help').hidden = false; $('#btn-help-close').focus(); });
  $('#btn-help-close').addEventListener('click', () => { $('#help').hidden = true; });
  const soundBtn = $('#btn-sound');
  const syncSound = () => (soundBtn.textContent = audio.on ? 'Sound on' : 'Sound off');
  soundBtn.addEventListener('click', () => { audio.on = !audio.on; store.set('pool.sound', audio.on ? 'on' : 'off'); audio.unlock(); syncSound(); });
  syncSound();

  // ------------------------------------------------------------------ hero (lobby)
  const heroState = C.newGame(0, (() => { let s = 3; return () => (s = (s * 16807) % 2147483647) / 2147483647; })());
  function drawHero() {
    heroR.resize();
    const r = heroR, ctx = r.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, r.canvas.width, r.canvas.height);
    if (!r.layer) return;
    ctx.drawImage(r.layer, 0, 0);
    r.worldTransform();
    const cue = heroState.balls[0];
    for (const b of heroState.balls) drawShadow(r, b.x, b.y);
    for (const b of heroState.balls) drawBall(r, b.n, b.x, b.y);
    drawCue(r, cue.x, cue.y, 1, -0.012, R + 34, 1);
  }

  // ------------------------------------------------------------------ loop
  let last = performance.now() / 1000;
  function frame(t) {
    const now = t / 1000;
    let dt = now - last; last = now;
    audio.budget = 6;
    if (dt > 0.3) { // tab was in the background: jump to the end of any shot
      if (app.anim) { while (!app.anim.sim.done) C.stepSim(app.anim.sim); finishShot(); }
      dt = 0;
    }
    if (app.charging && canAct()) { app.power = Math.min(1, app.power + dt / 1.3); app.aimDirty = true; }
    if (app.anim) stepAnim(dt, now);
    if (app.mode === 'online' && socket && canAct() && now - app.lastSend > 0.066) {
      if (app.aimDirty) { socket.volatile.emit('aim', { dx: app.aim.dx, dy: app.aim.dy, power: app.power, spin: app.spin }); app.aimDirty = false; app.lastSend = now; }
      if (app.placeDirty && app.place) { socket.volatile.emit('place', app.place); app.placeDirty = false; app.lastSend = now; }
    }
    if (current === 'game') {
      render(tableR, now);
      updatePowerBar();
      const ctl = $('.controls'), off = !canAct();
      if (ctl.classList.contains('disabled') !== off) updateHUD();
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ boot
  new ResizeObserver(() => { if (current === 'game') tableR.resize(); }).observe($('#table-wrap'));
  window.addEventListener('resize', () => { if (current === 'lobby') drawHero(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { tableR.resize(); drawHero(); });
  $('#name').value = store.get('pool.name') || '';
  const params = new URLSearchParams(location.search);
  const roomParam = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (roomParam) $('#code').value = roomParam;
  drawHero();
  requestAnimationFrame(frame);
  if (typeof window.io === 'function') {
    ensureSocket();
    // a reload drops you straight back into the room you were in
    let lastRoom = null;
    try { lastRoom = sessionStorage.getItem('pool.room'); } catch (e) { /* ignore */ }
    if (roomParam && lastRoom === roomParam) goOnline('join', roomParam);
  }
  window.__pool = { app, C, tableR, setState }; // handy for debugging in the console
})();
