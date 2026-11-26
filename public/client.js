(() => {
  'use strict';
  const C = window.PoolCore;
  const { W, H, R, POCKETS, BOUNDARY, HEAD_X, FOOT_X } = C;
  const PAD = 50;
  const WORLD_W = W + PAD * 2, WORLD_H = H + PAD * 2;
  const COLORS = { 1: '#f2b705', 2: '#1d4fa8', 3: '#c8102e', 4: '#5b2a86', 5: '#ee6c1b', 6: '#0f7a3d', 7: '#7b2418', 8: '#141414' };
  const colorOf = (n) => COLORS[n > 8 ? n - 8 : n];
  const IVORY = '#F4F1E8';
  const PLAYER = ['#FFC233', '#EF3B36'];
  const FOUL = '#FF7A1A';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // ------------------------------------------------------------------ screens
  const screens = { home: $('#home'), lobby: $('#lobby'), game: $('#game') };
  let current = 'home';
  function show(name) {
    current = name;
    for (const k in screens) screens[k].classList.toggle('active', k === name);
    if (name === 'game') requestAnimationFrame(() => tableR.resize());
    if (name === 'home') requestAnimationFrame(() => attractR.resize());
  }

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };
  const session = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  // one id per browser tab: a reload keeps your seat, a second tab is a new player
  let clientId = session.get('pool.cid');
  if (!clientId) { clientId = Math.random().toString(36).slice(2) + Date.now().toString(36); session.set('pool.cid', clientId); }

  // ------------------------------------------------------------------ state
  const app = {
    mode: null, seat: 0, code: null, players: [null, null], rematch: [false, false], gameId: 0,
    localNames: ['Player 1', 'Player 2'], localBreaker: 0, score: [0, 0],
    state: null, anim: null, pending: false, pendingTimer: 0,
    aim: { dx: 1, dy: 0 }, power: 0, spin: 0, charging: false,
    place: null, drag: null,
    remote: { aim: null, place: null, view: null, placeView: null },
    strike: null, potAnims: [], online: false,
    aimDirty: false, placeDirty: false, lastSend: 0,
  };

  let lastCaption = '';
  const myName = () => ($('#name').value.trim().slice(0, 16) || 'Player 1');
  function seatName(seat) {
    if (app.mode === 'local') return app.localNames[seat];
    const p = app.players[seat];
    return p ? p.name : 'Waiting…';
  }
  const isMe = (seat) => app.mode === 'online' && seat === app.seat;
  const who = (seat) => (isMe(seat) ? 'You' : seatName(seat));
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
      if (!myTurn() && app.remote.placeView) return app.remote.placeView;
    }
    const c = cueBall(s);
    return { x: c.x, y: c.y };
  }

  // ------------------------------------------------------------------ renderer
  function makeRenderer(canvas, allowRotate) {
    const r = { canvas, ctx: canvas.getContext('2d'), scale: 1, ox: 0, oy: 0, dpr: 1, layer: null, px: null, ballCache: {}, orient: makeOrients(), shadow: null, rot: false, allowRotate };
    r.resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      r.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      canvas.width = Math.round(rect.width * r.dpr);
      canvas.height = Math.round(rect.height * r.dpr);
      // stand the table on its end whenever that makes it noticeably bigger (upright phones and tablets)
      const flat = Math.min(rect.width / WORLD_W, rect.height / WORLD_H), upright = Math.min(rect.width / WORLD_H, rect.height / WORLD_W);
      r.rot = r.allowRotate && upright > flat * 1.04;
      const vw = r.rot ? WORLD_H : WORLD_W, vh = r.rot ? WORLD_W : WORLD_H;
      r.scale = Math.min(rect.width / vw, rect.height / vh);
      r.ox = (rect.width - vw * r.scale) / 2;
      r.oy = (rect.height - vh * r.scale) / 2;
      buildLayer(r); buildBallPixels(r);
    };
    r.toWorld = (cx, cy) => {
      const rect = canvas.getBoundingClientRect();
      const sx = (cx - rect.left - r.ox) / r.scale, sy = (cy - rect.top - r.oy) / r.scale;
      return r.rot ? { x: sy - PAD, y: WORLD_H - PAD - sx } : { x: sx - PAD, y: sy - PAD };
    };
    r.toScreen = (x, y) => (r.rot ? { x: r.ox + (WORLD_H - PAD - y) * r.scale, y: r.oy + (x + PAD) * r.scale }
      : { x: r.ox + (x + PAD) * r.scale, y: r.oy + (y + PAD) * r.scale });
    r.matrix = () => {
      const k = r.dpr * r.scale;
      return r.rot ? [0, k, -k, 0, r.dpr * (r.ox + (WORLD_H - PAD) * r.scale), r.dpr * (r.oy + PAD * r.scale)]
        : [k, 0, 0, k, r.dpr * (r.ox + PAD * r.scale), r.dpr * (r.oy + PAD * r.scale)];
    };
    r.worldTransform = () => r.ctx.setTransform(...r.matrix());
    return r;
  }
  const capture = (el, id) => { try { el.setPointerCapture(id); } catch (e) { /* pointer already gone */ } };

  function rrect(ctx, x, y, w, h, rad) { // adds a rounded-rect subpath to the current path
    ctx.moveTo(x + rad, y); ctx.arcTo(x + w, y, x + w, y + h, rad); ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad); ctx.arcTo(x, y, x + w, y, rad); ctx.closePath();
  }
  function roundRect(ctx, x, y, w, h, rad) { ctx.beginPath(); rrect(ctx, x, y, w, h, rad); }
  function boundaryPath(ctx) {
    ctx.beginPath();
    BOUNDARY.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
  }
  const CLOTH = [31, 102, 184];
  let feltTile = null;
  function makeFeltTile() {
    // fine wool texture: random fibres plus a faint weave, tiled across the bed
    const S = 192, cv = document.createElement('canvas'); cv.width = cv.height = S; // divisible by the weave periods, so it tiles seamlessly
    const ctx = cv.getContext('2d'), img = ctx.createImageData(S, S), d = img.data;
    let seed = 99; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4, weave = ((x + y) % 4 === 0 ? 10 : 0) + ((x - y + S) % 6 === 0 ? 6 : 0);
      const v = 128 + (rnd() - 0.5) * 70 + weave;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    for (let i = 0; i < 260; i++) { // stray fibres
      ctx.strokeStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)'; ctx.lineWidth = 0.6;
      const x = rnd() * S, y = rnd() * S, a = rnd() * Math.PI * 2, l = 2 + rnd() * 5;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { // wrap fibres across tile edges
        ctx.beginPath(); ctx.moveTo(x + ox, y + oy); ctx.lineTo(x + ox + Math.cos(a) * l, y + oy + Math.sin(a) * l); ctx.stroke();
      }
    }
    return cv;
  }

  function buildLayer(r) {
    const cv = document.createElement('canvas');
    cv.width = r.canvas.width; cv.height = r.canvas.height;
    const ctx = cv.getContext('2d');
    const k = r.dpr * r.scale;
    const world = () => ctx.setTransform(...r.matrix());
    world();

    // the table's shadow on the floor
    ctx.save();
    ctx.shadowColor = 'rgba(2,5,18,0.7)'; ctx.shadowBlur = 50 * k;
    if (r.rot) ctx.shadowOffsetX = 18 * k; else ctx.shadowOffsetY = 18 * k;
    roundRect(ctx, -PAD, -PAD, WORLD_W, WORLD_H, 24); ctx.fillStyle = '#140c07'; ctx.fill();
    ctx.restore();

    // walnut rails, each with its own grain direction and a rounded top
    const O = PAD, I = 24;
    const rails = [
      { pts: [[-O, -O], [W + O, -O], [W + I, -I], [-I, -I]], g: [0, -O, 0, -I], along: 'x' },
      { pts: [[-I, H + I], [W + I, H + I], [W + O, H + O], [-O, H + O]], g: [0, H + O, 0, H + I], along: 'x' },
      { pts: [[-O, -O], [-I, -I], [-I, H + I], [-O, H + O]], g: [-O, 0, -I, 0], along: 'y' },
      { pts: [[W + I, -I], [W + O, -O], [W + O, H + O], [W + I, H + I]], g: [W + O, 0, W + I, 0], along: 'y' },
    ];
    ctx.save(); roundRect(ctx, -O, -O, WORLD_W, WORLD_H, 24); ctx.clip();
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const rail of rails) {
      ctx.save();
      ctx.beginPath(); rail.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.clip();
      const gr = ctx.createLinearGradient(...rail.g);
      gr.addColorStop(0, '#24140b'); gr.addColorStop(0.35, '#3f2614'); gr.addColorStop(0.75, '#4c2e19'); gr.addColorStop(0.93, '#5c3a21'); gr.addColorStop(1, '#2a180c');
      ctx.fillStyle = gr; ctx.fillRect(-O, -O, WORLD_W, WORLD_H);
      for (let i = 0; i < 90; i++) {
        const dark = rnd() < 0.6;
        ctx.strokeStyle = dark ? `rgba(18,8,2,${0.12 + rnd() * 0.22})` : `rgba(160,105,60,${0.05 + rnd() * 0.1})`;
        ctx.lineWidth = 0.4 + rnd() * 1.4;
        ctx.beginPath();
        if (rail.along === 'x') {
          const y = rail.g[1] + (rail.g[3] - rail.g[1]) * rnd(), w = (rnd() - 0.5) * 4;
          ctx.moveTo(-O, y); ctx.bezierCurveTo(W * 0.3, y + w, W * 0.6, y - w, W + O, y + w * 0.5);
        } else {
          const x = rail.g[0] + (rail.g[2] - rail.g[0]) * rnd(), w = (rnd() - 0.5) * 4;
          ctx.moveTo(x, -O); ctx.bezierCurveTo(x + w, H * 0.3, x - w, H * 0.6, x + w * 0.5, H + O);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
    // satin finish: a soft sheen along the outer edge and a dark mitre where rails meet
    roundRect(ctx, -O + 1, -O + 1, WORLD_W - 2, WORLD_H - 2, 23); ctx.strokeStyle = 'rgba(255,214,170,0.16)'; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.strokeStyle = 'rgba(10,4,0,0.35)'; ctx.lineWidth = 0.8;
    for (const [a, b] of [[[-O, -O], [-I, -I]], [[W + O, -O], [W + I, -I]], [[-O, H + O], [-I, H + I]], [[W + O, H + O], [W + I, H + I]]]) {
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }

    // cushion rubber under the cloth
    roundRect(ctx, -I, -I, W + 2 * I, H + 2 * I, 3);
    ctx.fillStyle = '#195aa2'; ctx.fill();
    ctx.strokeStyle = 'rgba(8,4,2,0.75)'; ctx.lineWidth = 1.6; ctx.stroke();

    // the bed: lit by a long lamp above the middle of the table
    boundaryPath(ctx);
    ctx.fillStyle = `rgb(${CLOTH[0]},${CLOTH[1]},${CLOTH[2]})`; ctx.fill();
    ctx.save(); boundaryPath(ctx); ctx.clip();
    for (const cx of [W * 0.3, W * 0.7]) {
      const g = ctx.createRadialGradient(cx, H / 2, 10, cx, H / 2, W * 0.42);
      g.addColorStop(0, 'rgba(120,180,255,0.20)'); g.addColorStop(1, 'rgba(120,180,255,0)');
      ctx.fillStyle = g; ctx.fillRect(-40, -40, W + 80, H + 80);
    }
    const vig = ctx.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, W * 0.62);
    vig.addColorStop(0, 'rgba(0,10,40,0)'); vig.addColorStop(1, 'rgba(0,10,40,0.34)');
    ctx.fillStyle = vig; ctx.fillRect(-40, -40, W + 80, H + 80);
    // felt texture in screen pixels
    if (!feltTile) feltTile = makeFeltTile();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = 0.22;
    ctx.fillStyle = ctx.createPattern(feltTile, 'repeat'); ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    world();
    // shadow under the cushion noses
    boundaryPath(ctx); ctx.strokeStyle = 'rgba(2,14,40,0.38)'; ctx.lineWidth = 9; ctx.stroke();
    ctx.strokeStyle = 'rgba(2,14,40,0.25)'; ctx.lineWidth = 4; ctx.stroke();
    ctx.restore();

    // cushion faces: lit tops and a bright nose line
    ctx.save();
    roundRect(ctx, -I, -I, W + 2 * I, H + 2 * I, 3);
    BOUNDARY.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
    ctx.clip('evenodd');
    boundaryPath(ctx);
    ctx.strokeStyle = 'rgba(160,205,255,0.20)'; ctx.lineWidth = 14; ctx.stroke();
    ctx.strokeStyle = 'rgba(200,228,255,0.30)'; ctx.lineWidth = 4; ctx.stroke();
    ctx.restore();
    boundaryPath(ctx); ctx.strokeStyle = 'rgba(225,240,255,0.35)'; ctx.lineWidth = 0.9; ctx.stroke();

    // spots
    for (const x of [HEAD_X, FOOT_X]) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.arc(x + 0.4, H / 2 + 0.6, 2.8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(240,244,250,0.85)'; ctx.beginPath(); ctx.arc(x, H / 2, 2.5, 0, Math.PI * 2); ctx.fill();
    }

    // pockets: polished castings on the rails, rubber liners, deep holes
    ctx.save();
    ctx.beginPath(); ctx.rect(-O - 5, -O - 5, WORLD_W + 10, WORLD_H + 10); rrect(ctx, -I, -I, W + 2 * I, H + 2 * I, 3);
    ctx.clip('evenodd');
    ctx.save(); roundRect(ctx, -O, -O, WORLD_W, WORLD_H, 24); ctx.clip();
    for (const p of POCKETS) {
      const corner = p.r > 23, rad = p.r + (corner ? 13 : 10);
      const g = ctx.createLinearGradient(p.x - rad, p.y - rad, p.x + rad, p.y + rad);
      g.addColorStop(0, '#c9ced5'); g.addColorStop(0.4, '#8a919b'); g.addColorStop(0.6, '#a9b0b9'); g.addColorStop(1, '#4b5058');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(15,10,6,0.7)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.arc(p.x, p.y, rad - 1.2, Math.PI * 1.05, Math.PI * 1.6); ctx.stroke();
      ctx.fillStyle = '#121214'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 5.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    ctx.restore();
    for (const p of POCKETS) {
      const g = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, p.r + 3.5);
      g.addColorStop(0, '#000'); g.addColorStop(0.7, '#020203'); g.addColorStop(0.92, '#121318'); g.addColorStop(1, '#2a2c33');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 3.5, 0, Math.PI * 2); ctx.fill();
    }

    // mother-of-pearl sights
    const sight = (x, y) => {
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.moveTo(x + 0.5, y - 4); ctx.lineTo(x + 3.5, y + 0.5); ctx.lineTo(x + 0.5, y + 5); ctx.lineTo(x - 2.5, y + 0.5); ctx.closePath(); ctx.fill();
      const g = ctx.createLinearGradient(x - 3, y - 4, x + 3, y + 4);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.5, '#dfe6ee'); g.addColorStop(1, '#b6c3d3');
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x, y - 4.5); ctx.lineTo(x + 3, y); ctx.lineTo(x, y + 4.5); ctx.lineTo(x - 3, y); ctx.closePath(); ctx.fill();
    };
    for (let i = 1; i < 8; i++) { if (i === 4) continue; sight(W * i / 8, -37); sight(W * i / 8, H + 37); }
    for (let i = 1; i < 4; i++) { sight(-37, H * i / 4); sight(W + 37, H * i / 4); }
    r.layer = cv;
  }

  // ---------- 3D balls that roll ----------
  // Each ball keeps an orientation (body -> world rotation). Every frame the ball is turned by
  // its rolling velocity, then shaded per pixel: stripes, number discs and highlights all move
  // like the real thing. Lighting is fixed to the screen so highlights stay put while balls roll.
  const BALL_RGB = { 0: [246, 244, 236], 1: [242, 183, 5], 2: [29, 79, 168], 3: [200, 16, 46], 4: [91, 42, 134], 5: [238, 108, 27], 6: [15, 122, 61], 7: [123, 36, 24], 8: [22, 22, 24] };
  const IVORY_RGB = [244, 241, 232];
  const DISC_COS = Math.cos(0.5), DISC_SIN = Math.sin(0.5), STRIPE_W = 0.55, DOT_COS = Math.cos(0.12);
  const G = 48, glyphs = {};
  function buildGlyphs() {
    const cv = document.createElement('canvas'); cv.width = cv.height = G;
    const ctx = cv.getContext('2d');
    for (let n = 1; n <= 15; n++) {
      ctx.clearRect(0, 0, G, G); ctx.fillStyle = '#000';
      ctx.font = `800 ${n > 9 ? 25 : 29}px Archivo, system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (n > 9) { ctx.save(); ctx.translate(G / 2, G / 2 + 1.5); ctx.scale(0.86, 1); ctx.fillText(String(n), 0, 0); ctx.restore(); }
      else ctx.fillText(String(n), G / 2, G / 2 + 1.5);
      if (n === 6 || n === 9) ctx.fillRect(G / 2 - 6, G / 2 + 13, 12, 2.2); // tell 6 and 9 apart
      const d = ctx.getImageData(0, 0, G, G).data, a = new Uint8Array(G * G);
      for (let i = 0; i < G * G; i++) a[i] = d[i * 4 + 3];
      glyphs[n] = a;
    }
  }
  function makeOrients() { return { m: {}, ver: {} }; }
  function resetOrient(set, n, rand) {
    // number facing up with a little tilt, turned to a random angle in the table plane
    const a = rand() * Math.PI * 2, t1 = (rand() - 0.5) * 0.7, t2 = (rand() - 0.5) * 0.7;
    let m = [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
    m = mul3(rotAxis(1, 0, 0, t1), m); m = mul3(rotAxis(0, 1, 0, t2), m);
    set.m[n] = m; set.ver[n] = (set.ver[n] || 0) + 1;
  }
  function resetAll(set) { for (let n = 0; n <= 15; n++) resetOrient(set, n, Math.random); }
  function rotAxis(x, y, z, t) {
    const c = Math.cos(t), s = Math.sin(t), v = 1 - c;
    return [c + x * x * v, x * y * v - z * s, x * z * v + y * s, y * x * v + z * s, c + y * y * v, y * z * v - x * s, z * x * v - y * s, z * y * v + x * s, c + z * z * v];
  }
  function mul3(a, b) {
    const o = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return o;
  }
  function orthonormalize(m) {
    let ax = m[0], ay = m[3], az = m[6], l = Math.sqrt(ax * ax + ay * ay + az * az); ax /= l; ay /= l; az /= l;
    let bx = m[1], by = m[4], bz = m[7]; const d = ax * bx + ay * by + az * bz; bx -= d * ax; by -= d * ay; bz -= d * az;
    l = Math.sqrt(bx * bx + by * by + bz * bz); bx /= l; by /= l; bz /= l;
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    m[0] = ax; m[3] = ay; m[6] = az; m[1] = bx; m[4] = by; m[7] = bz; m[2] = cx; m[5] = cy; m[8] = cz;
  }
  // turn every moving ball by how far its surface rolled this frame
  function rollBalls(set, balls, dt) {
    for (const b of balls) {
      if (b.in) continue;
      const rx = b.rx || 0, ry = b.ry || 0, sp = Math.sqrt(rx * rx + ry * ry);
      if (sp < 0.5) continue;
      if (!set.m[b.n]) resetOrient(set, b.n, Math.random);
      // world: x right, y down, z into the table. Rolling without slip: w = (ry, -rx, 0) / R
      const ang = sp * dt / R;
      set.m[b.n] = mul3(rotAxis(ry / sp, -rx / sp, 0, ang), set.m[b.n]);
      set.ver[b.n]++;
      if (set.ver[b.n] % 30 === 0) orthonormalize(set.m[b.n]);
    }
  }

  function buildBallPixels(r) {
    // per-pixel normals and lighting for one ball sprite at this size
    const k = r.dpr * r.scale, rho = R * k, S = Math.ceil(2 * rho) + 4, c = S / 2;
    const L = [[-0.2, -0.42, -0.885], [0.06, -0.44, -0.896]].map((v) => { const l = Math.hypot(...v); return v.map((x) => x / l); });
    const Lm = (() => { const v = [-0.18, -0.36, -0.92], l = Math.hypot(...v); return v.map((x) => x / l); })();
    const H2 = L.map((l) => { const h = [l[0], l[1], l[2] - 1], n = Math.hypot(...h); return h.map((x) => x / n); });
    const list = { S, idx: [], nx: [], ny: [], nz: [], a: [], shade: [], spec: [], bounce: [] };
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const dx = (i + 0.5 - c) / rho, dy = (j + 0.5 - c) / rho, d2 = dx * dx + dy * dy;
      const dist = Math.sqrt(d2), a = Math.max(0, Math.min(1, (1 - dist) * rho + 0.5));
      if (a <= 0) continue;
      const dd = Math.min(d2, 0.9999), nz = -Math.sqrt(1 - dd), sc = d2 > 0.9999 ? 1 / dist : 1;
      const nx = dx * sc, ny = dy * sc;
      const diff = Math.max(0, nx * Lm[0] + ny * Lm[1] + nz * Lm[2]);
      let spec = 0;
      for (const h of H2) { const t = Math.max(0, nx * h[0] + ny * h[1] + nz * h[2]); spec += Math.pow(t, 90) * 0.75 + Math.pow(t, 12) * 0.05; }
      const facing = -nz;
      list.idx.push((j * S + i) * 4); list.nx.push(nx); list.ny.push(ny); list.nz.push(nz); list.a.push(Math.round(a * 255));
      list.shade.push((0.34 + 0.7 * diff) * (0.78 + 0.22 * facing));
      list.spec.push(spec * 255);
      list.bounce.push(Math.pow(1 - facing, 2) * 0.28);
    }
    r.px = list; r.ballCache = {};
    const scv = document.createElement('canvas'); scv.width = scv.height = Math.ceil(R * 3.2 * k);
    const sctx = scv.getContext('2d'), sc = scv.width / 2;
    const g = sctx.createRadialGradient(sc, sc, 0, sc, sc, sc);
    g.addColorStop(0, 'rgba(0,6,24,0.62)'); g.addColorStop(0.42, 'rgba(0,6,24,0.42)'); g.addColorStop(0.7, 'rgba(0,6,24,0.12)'); g.addColorStop(1, 'rgba(0,6,24,0)');
    sctx.fillStyle = g; sctx.fillRect(0, 0, scv.width, scv.height);
    r.shadow = scv;
  }

  function ballSprite(r, n) {
    const P = r.px, set = r.orient;
    if (!set.m[n]) resetOrient(set, n, Math.random);
    let c = r.ballCache[n];
    if (!c) {
      const cv = document.createElement('canvas'); cv.width = cv.height = P.S;
      const ctx = cv.getContext('2d');
      c = r.ballCache[n] = { cv, ctx, img: ctx.createImageData(P.S, P.S), ver: -1 };
    }
    if (c.ver === set.ver[n]) return c.cv;
    c.ver = set.ver[n];
    const M = set.m[n], d = c.img.data, glyph = glyphs[n];
    const base = n > 8 ? BALL_RGB[n - 8] : BALL_RGB[n], stripe = n > 8, cue = n === 0;
    const rot = r.rot, cnt = P.idx.length;
    for (let q = 0; q < cnt; q++) {
      let wx = P.nx[q], wy = P.ny[q]; const wz = P.nz[q];
      if (rot) { const t = wx; wx = wy; wy = -t; } // screen -> world when the table is stood on end
      const px = M[0] * wx + M[3] * wy + M[6] * wz, py = M[1] * wx + M[4] * wy + M[7] * wz, pz = M[2] * wx + M[5] * wy + M[8] * wz;
      let cr = base[0], cg = base[1], cb = base[2];
      if (cue) {
        if (px > DOT_COS || px < -DOT_COS || py > DOT_COS || py < -DOT_COS || pz > DOT_COS || pz < -DOT_COS) { cr = 190; cg = 24; cb = 40; }
      } else {
        if (stripe && (px > STRIPE_W || px < -STRIPE_W)) { cr = IVORY_RGB[0]; cg = IVORY_RGB[1]; cb = IVORY_RGB[2]; }
        if (pz > DISC_COS || pz < -DISC_COS) {
          cr = IVORY_RGB[0]; cg = IVORY_RGB[1]; cb = IVORY_RGB[2];
          if (glyph) {
            const u = (pz < 0 ? px : -px) / DISC_SIN, v = py / DISC_SIN;
            const gx = (u * 0.5 + 0.5) * G | 0, gy = (v * 0.5 + 0.5) * G | 0;
            if (gx >= 0 && gx < G && gy >= 0 && gy < G) {
              const t = glyph[gy * G + gx] / 255;
              cr += (20 - cr) * t; cg += (20 - cg) * t; cb += (22 - cb) * t;
            }
          }
        }
      }
      const sh = P.shade[q], sp = P.spec[q], bo = P.bounce[q], i = P.idx[q];
      d[i] = Math.min(255, cr * sh + sp + CLOTH[0] * bo);
      d[i + 1] = Math.min(255, cg * sh + sp + CLOTH[1] * bo);
      d[i + 2] = Math.min(255, cb * sh + sp + CLOTH[2] * bo);
      d[i + 3] = P.a[q];
    }
    c.ctx.putImageData(c.img, 0, 0);
    return c.cv;
  }

  function drawBall(r, n, x, y, scale, alpha) {
    const ctx = r.ctx, sprite = ballSprite(r, n), k = r.dpr * r.scale, s = sprite.width / k * (scale || 1);
    if (alpha !== undefined) ctx.globalAlpha = alpha;
    if (r.rot) { ctx.save(); ctx.translate(x, y); ctx.rotate(-Math.PI / 2); ctx.drawImage(sprite, -s / 2, -s / 2, s, s); ctx.restore(); }
    else ctx.drawImage(sprite, x - s / 2, y - s / 2, s, s);
    ctx.globalAlpha = 1;
  }
  function drawShadow(r, x, y) {
    // light hangs above, so shadows sit just below each ball on screen
    const ox = 1.2, oy = 2.4, wx = r.rot ? oy : ox, wy = r.rot ? -ox : oy, s = R * 3.2;
    r.ctx.drawImage(r.shadow, x + wx - s / 2, y + wy - s / 2, s, s);
  }

  // a classic two-piece cue: chalked tip, maple shaft, ebony forearm with points, linen wrap.
  // The joint ring wears the shooter's colour.
  function drawCue(r, cx, cy, dx, dy, gap, alpha, ring) {
    const ctx = r.ctx;
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.translate(cx, cy); ctx.rotate(Math.atan2(dy, dx));
    const L = 640, x0 = -gap, w0 = 2.5, w1 = 6.4;
    const wAt = (x) => w0 + (w1 - w0) * ((x0 - x) / L);
    const seg = (a, b, fill) => {
      const wa = wAt(a), wb = wAt(b);
      ctx.beginPath(); ctx.moveTo(a, -wa); ctx.lineTo(b, -wb); ctx.lineTo(b, wb); ctx.lineTo(a, wa); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
    };
    const across = (stops) => { const g = ctx.createLinearGradient(0, -6.5, 0, 6.5); stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c)); return g; };
    // shadow on the cloth
    ctx.save(); ctx.shadowColor = 'rgba(0,6,24,0.5)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 8;
    seg(x0, x0 - L, '#000'); ctx.restore();
    seg(x0 - 11, x0 - 330, across(['#b8945e', '#f1dcb2', '#e2c38d', '#a47f4a']));          // maple shaft
    seg(x0 - 330, x0 - 341, across(['#7d848f', '#eef1f5', '#b9bfc8', '#5d636c']));         // steel joint
    seg(x0 - 341, x0 - 346, ring || PLAYER[0]);                                            // player ring
    seg(x0 - 346, x0 - 505, across(['#0c0705', '#3a2519', '#1d120b', '#070403']));         // ebony forearm
    ctx.save(); // maple points running toward the joint
    ctx.beginPath(); ctx.moveTo(x0 - 505, -wAt(x0 - 505) * 0.7); ctx.lineTo(x0 - 372, 0); ctx.lineTo(x0 - 505, wAt(x0 - 505) * 0.7); ctx.closePath();
    ctx.fillStyle = across(['#9c7a48', '#ecd3a3', '#c9a46b']); ctx.fill(); ctx.restore();
    seg(x0 - 505, x0 - 592, across(['#141416', '#3a3b40', '#232428', '#0d0d0f']));         // linen wrap
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 0.6;
    for (let x = x0 - 507; x > x0 - 590; x -= 2.2) { const w = wAt(x); ctx.beginPath(); ctx.moveTo(x, -w); ctx.lineTo(x - 2, w); ctx.stroke(); }
    ctx.restore();
    seg(x0 - 592, x0 - 598, ring || PLAYER[0]);
    seg(x0 - 598, x0 - 633, across(['#0c0705', '#3a2519', '#1d120b', '#070403']));         // butt sleeve
    seg(x0 - 633, x0 - L, '#0a0a0b');                                                      // bumper
    seg(x0 - 3, x0 - 11, across(['#c9c4b8', '#fbf9f4', '#e7e2d6', '#a8a396']));           // ferrule
    seg(x0, x0 - 3, across(['#1f4f86', '#3f86cf', '#2c6aaa']));                            // chalked tip
    // long highlight down the top of the cue
    ctx.beginPath(); ctx.moveTo(x0 - 12, -wAt(x0 - 12) * 0.45); ctx.lineTo(x0 - L + 8, -wAt(x0 - L + 8) * 0.45);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 0.9; ctx.stroke();
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
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1.4; ctx.setLineDash([7, 6]);
    const back = g.type === 'ball' ? R : 0;
    ctx.beginPath(); ctx.moveTo(cx + dx * R, cy + dy * R); ctx.lineTo(g.gx - dx * back, g.gy - dy * back); ctx.stroke();
    ctx.setLineDash([]);
    if (g.type === 'ball') {
      ctx.beginPath(); ctx.arc(g.gx, g.gy, R, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.4; ctx.stroke();
      const L = 110;
      ctx.lineWidth = 2.2; ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath(); ctx.moveTo(g.hit.x + g.nx * R, g.hit.y + g.ny * R); ctx.lineTo(g.hit.x + g.nx * (R + L * g.cos), g.hit.y + g.ny * (R + L * g.cos)); ctx.stroke();
      const s = Math.sqrt(Math.max(0, 1 - g.cos * g.cos));
      ctx.strokeStyle = 'rgba(170,215,255,0.6)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(g.gx + g.px * R, g.gy + g.py * R); ctx.lineTo(g.gx + g.px * (R + L * 0.7 * s), g.gy + g.py * (R + L * 0.7 * s)); ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.setLineDash([3, 6]);
      ctx.beginPath(); ctx.moveTo(g.gx, g.gy); ctx.lineTo(g.gx + g.rdx * 70, g.gy + g.rdy * 70); ctx.stroke();
    }
    ctx.restore();
  }

  function drawPotAnims(r, list, now) {
    for (const a of list) {
      const t = Math.min(1, (now - a.t0) / 0.24), pk = POCKETS[a.p];
      drawBall(r, a.n, a.x + (pk.x - a.x) * t, a.y + (pk.y - a.y) * t, 1 - 0.4 * t, 1 - t);
    }
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
    const ring = PLAYER[s.turn];

    if (placing && s.kitchen) {
      ctx.fillStyle = 'rgba(255,255,255,0.035)'; ctx.fillRect(0, 0, HEAD_X, H);
      ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.2; ctx.setLineDash([6, 7]);
      ctx.beginPath(); ctx.moveTo(HEAD_X, 4); ctx.lineTo(HEAD_X, H - 4); ctx.stroke(); ctx.restore();
    }
    for (const b of balls) { const p = (b.n === 0 && cp) ? cp : b; drawShadow(r, p.x, p.y); }
    for (const b of balls) { const p = (b.n === 0 && cp) ? cp : b; drawBall(r, b.n, p.x, p.y); }
    app.potAnims = app.potAnims.filter((a) => now - a.t0 < 0.24);
    drawPotAnims(r, app.potAnims, now);

    if (placing && cp) {
      ctx.save(); ctx.setLineDash([4, 5]); ctx.lineWidth = 1.6;
      ctx.strokeStyle = myTurn() ? ring : 'rgba(255,255,255,0.5)';
      ctx.beginPath(); ctx.arc(cp.x, cp.y, R + 6, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
    if (!anim && s.phase !== 'over' && cp && bothHere()) {
      if (myTurn() && !app.pending) {
        if (!(app.drag && app.drag.kind === 'place')) {
          drawGuide(r, cp.x, cp.y, app.aim.dx, app.aim.dy, s.balls, 1);
          drawCue(r, cp.x, cp.y, app.aim.dx, app.aim.dy, R + 4 + app.power * 80, 1, ring);
        }
      } else if (!myTurn() && app.remote.view) {
        const v = app.remote.view, dx = Math.cos(v.ang), dy = Math.sin(v.ang);
        drawGuide(r, cp.x, cp.y, dx, dy, s.balls, 0.5);
        drawCue(r, cp.x, cp.y, dx, dy, R + 4 + v.power * 80, 0.85, ring);
      }
    }
    const st = app.strike;
    if (st) {
      const t = now - st.t0;
      let gap, alpha = 1;
      if (t < 0.09) gap = R + 4 + st.power * 80 * (1 - t / 0.09);
      else if (!st.hitAt) gap = R + 1;
      else { const u = Math.min(1, (t - st.hitAt) / 0.35); gap = R + 1 - 10 * u; alpha = 1 - u; if (u >= 1) app.strike = null; }
      if (app.strike) drawCue(r, st.x, st.y, st.dx, st.dy, gap, alpha, st.ring);
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
        node.connect(g); g.connect(this.master);
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
      else if (kind === 'rail') noise('lowpass', 520, 0.8, 0.8 * vol, 0.09);
      else if (kind === 'pocket') { tone(140, 55, 0.5 * vol, 0.22); noise('lowpass', 380, 0.7, 0.5 * vol, 0.16); }
      else if (kind === 'cue') { noise('bandpass', 1700, 0.9, 0.8 * vol, 0.04); tone(700, 500, 0.1 * vol, 0.03); }
    },
  };

  // ------------------------------------------------------------------ shots
  function beginShot(start, input, result, score) {
    if (app.anim) finishShot();
    const now = performance.now() / 1000;
    if (!app.strike || app.strike.hitAt) {
      const c = input.cue || cueBall(start);
      app.strike = { t0: now, x: c.x, y: c.y, dx: input.dx, dy: input.dy, power: input.power, ring: PLAYER[start.turn] };
    }
    const elapsed = now - app.strike.t0;
    app.anim = { sim: C.createSim(start, input), result, score, acc: 0, delay: Math.max(0, 0.09 - elapsed), ev: 0, played: false, power: input.power };
    app.pending = false; clearTimeout(app.pendingTimer);
    app.remote.aim = null; app.remote.place = null; app.remote.view = null; app.remote.placeView = null;
    app.power = 0; app.charging = false;
    lastCaption = app.mode === 'online' && isMe(start.turn) ? 'Your shot.' : `${seatName(start.turn)}’s shot.`;
    updateHUD();
  }

  function stepAnim(dt, now) {
    const a = app.anim;
    if (a.delay > 0) { a.delay -= dt; if (a.delay > 0) return; dt = -a.delay; }
    if (!a.played) { a.played = true; audio.play('cue', 0.2 + a.power); if (app.strike) app.strike.hitAt = now - app.strike.t0; }
    a.acc += dt;
    let steps = Math.floor(a.acc / C.DT);
    a.acc -= steps * C.DT;
    let ran = 0;
    while (steps-- > 0 && !a.sim.done) { C.stepSim(a.sim); ran++; }
    rollBalls(tableR.orient, a.sim.balls, ran * C.DT);
    const ev = a.sim.events;
    for (; a.ev < ev.length; a.ev++) {
      const e = ev[a.ev];
      if (e.t === 'ball') audio.play('ball', e.s / 1400);
      else if (e.t === 'rail') audio.play('rail', e.s / 1600);
      else if (e.t === 'pocket') { audio.play('pocket', 0.8); app.potAnims.push({ n: e.n, x: e.x, y: e.y, p: e.p, t0: now }); }
    }
    if (a.sim.done) finishShot();
  }

  function finishShot() {
    const a = app.anim;
    if (!a) return;
    app.anim = null;
    if (a.score) app.score = a.score.slice();
    setState(a.result, true);
  }

  function setState(st, afterShot) {
    const wasOver = app.state && app.state.phase === 'over';
    app.state = st;
    const c = cueBall(st);
    app.place = st.ballInHand ? { x: c.x, y: c.y } : null;
    app.power = 0; app.spin = 0; app.charging = false;
    app.remote.place = null; app.remote.placeView = null; app.remote.aim = null; app.remote.view = null;
    if (st.shotNo === 0) { app.aim = { dx: 1, dy: 0 }; resetAll(tableR.orient); }
    if (app.mode === 'local' && afterShot && st.phase === 'over' && !wasOver) app.score[st.winner]++;
    updateSpin();
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
    app.strike = { t0: performance.now() / 1000, x: c.x, y: c.y, dx: input.dx, dy: input.dy, power, ring: PLAYER[s.turn] };
    if (app.mode === 'local') {
      const res = C.applyShot(s, input);
      if (!res.ok) { app.strike = null; showTag('Can’t shoot', res.error, FOUL); return; }
      beginShot(s, res.input, res.state, null);
    } else {
      app.pending = true;
      socket.emit('shoot', input);
      clearTimeout(app.pendingTimer);
      app.pendingTimer = setTimeout(() => {
        if (app.pending) { app.pending = false; app.strike = null; showTag('Not sent', 'That shot didn’t reach the server. Take it again.', FOUL); updateHUD(); }
      }, 6000);
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
      const plate = $('#sb' + seat);
      plate.querySelector('.sb-name').textContent = seatName(seat);
      const flag = plate.querySelector('.sb-flag');
      const p = app.players[seat];
      flag.className = 'sb-flag';
      if (app.mode === 'online' && p && !p.connected) { flag.textContent = 'Offline'; flag.classList.add('off'); }
      else flag.textContent = isMe(seat) ? 'You' : '';
      const ballsEl = plate.querySelector('.sb-balls');
      ballsEl.textContent = '';
      if (s) {
        const g = s.groups[seat];
        if (!g) ballsEl.textContent = s.phase === 'break' ? (s.turn === seat ? 'To break' : '') : 'Open table';
        else {
          const nums = g === C.SOLIDS ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
          let left = 0;
          for (const n of nums) { const gone = s.balls.find((b) => b.n === n).in; if (!gone) left++; ballsEl.appendChild(miniBall(n, gone)); }
          if (!left) ballsEl.appendChild(miniBall(8, false));
        }
      }
      plate.classList.toggle('on', !!s && s.phase !== 'over' && s.turn === seat);
    }
    $('#score0').textContent = app.score[0];
    $('#score1').textContent = app.score[1];
    const played = app.score[0] + app.score[1];
    $('#frame-label').textContent = `Frame ${s && s.phase === 'over' ? Math.max(1, played) : played + 1}`;

    // lower-third caption
    const cap = $('#caption'), status = $('#status');
    if (s) cap.style.setProperty('--pc', PLAYER[s.turn]);
    if (!(app.anim || app.pending)) lastCaption = statusText();
    status.textContent = lastCaption;
    const opp = app.mode === 'online' && app.seat >= 0 ? app.players[1 - app.seat] : null;
    if (app.mode === 'online' && (!app.online || (opp && !opp.connected))) {
      const w = document.createElement('span'); w.className = 'warn';
      w.textContent = !app.online ? 'Connection lost. Reconnecting…' : 'Your opponent dropped out. Waiting for them to come back.';
      status.appendChild(w);
    }
    cap.classList.toggle('quiet', !status.textContent);

    $('#dock').classList.toggle('idle', !canAct());
    const chip = $('#room-chip');
    chip.hidden = !(app.mode === 'online' && app.code);
    $('#room-chip-code').textContent = app.code || '';
    syncSound();
  }

  function statusText() {
    const s = app.state;
    if (!s) return '';
    if (s.phase === 'over') return 'Frame over';
    const t = s.turn, mine = isMe(t) || app.mode === 'local';
    const name = seatName(t);
    let txt;
    if (app.mode === 'online' && app.seat < 0) txt = `You’re watching. ${name} ${s.phase === 'break' ? 'to break' : 'at the table'}.`;
    else if (s.phase === 'break') txt = isMe(t) ? 'Your break.' : `${name} to break.`;
    else txt = isMe(t) ? 'Your shot.' : `${name}’s shot.`;
    if (s.ballInHand && mine) txt += s.kitchen ? ' Place the cue ball behind the line, then shoot.' : ' Ball in hand: drag the cue ball anywhere.';
    else if (s.ballInHand) txt += ' Ball in hand.';
    const g = s.groups[t];
    if (g && C.remaining(s, g) === 0) txt += ' On the 8.';
    return txt;
  }

  function announce(st, shot) {
    if (st.phase === 'over') return;
    const by = who(shot.by), next = who(st.turn), you = (n) => n === 'You';
    if (shot.foul) showTag('Foul', `${shot.foul}. ${next} ${you(next) ? 'have' : 'has'} ball in hand.`, FOUL);
    else if (shot.assigned) showTag(by, `${you(by) ? 'take' : 'takes'} ${shot.assigned}.`, PLAYER[shot.by]);
    else if (shot.eightSpotted) showTag('Break', 'The 8 went down, so it’s back on its spot.', '#F5F7FB');
    else if (shot.potted.length && shot.continued) {
      const what = shot.potted.length > 1 ? `${shot.potted.length} balls` : `the ${shot.potted[0]}`;
      showTag(by, `potted ${what}. ${you(by) ? 'Go again.' : 'Shoots again.'}`, PLAYER[shot.by]);
    }
  }

  let tagTimer = 0;
  function showTag(kind, text, color) {
    const t = $('#tag');
    t.querySelector('.tag-kind').textContent = kind;
    t.querySelector('.tag-text').textContent = text;
    t.style.setProperty('--kc', color || '#F5F7FB');
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    clearTimeout(tagTimer); tagTimer = setTimeout(() => t.classList.remove('show'), 3000);
  }

  function showOver() {
    const s = app.state, shot = s.lastShot || {}, w = s.winner;
    clearTimeout(tagTimer); $('#tag').classList.remove('show');
    $('.over-band').style.setProperty('--pc', PLAYER[w]);
    $('#over-title').textContent = isMe(w) ? 'You take the frame' : `${seatName(w)} takes the frame`;
    $('#over-reason').textContent = shot.reason ? `${who(shot.by)} ${shot.reason.charAt(0).toLowerCase() + shot.reason.slice(1)}.` : '';
    const sc = $('#over-score'); sc.textContent = `${app.score[0]}–${app.score[1]}`;
    sc.title = `${seatName(0)} ${app.score[0]}, ${seatName(1)} ${app.score[1]}`;
    const btn = $('#btn-rematch'), note = $('#over-note');
    btn.hidden = app.mode === 'online' && app.seat < 0;
    if (app.mode === 'local') { btn.textContent = 'Rematch'; btn.disabled = false; note.textContent = ''; }
    else {
      const mine = app.rematch[app.seat], theirs = app.rematch[1 - app.seat];
      btn.textContent = mine ? 'Waiting for opponent…' : 'Rematch';
      btn.disabled = !!mine;
      note.textContent = app.seat < 0 ? 'Waiting for the players to start the next frame.' : (theirs && !mine ? `${seatName(1 - app.seat)} wants a rematch.` : '');
    }
  }

  // ------------------------------------------------------------------ controls
  const tableR = makeRenderer($('#table'), true);
  const attractR = makeRenderer($('#attract'), false);
  const canvas = $('#table');

  function setAimToward(x, y) {
    const c = cuePos(), dx = x - c.x, dy = y - c.y, l = Math.sqrt(dx * dx + dy * dy);
    if (l < 2) return;
    app.aim = { dx: dx / l, dy: dy / l }; app.aimDirty = true;
  }
  function rotateAim(delta) {
    const a = Math.atan2(app.aim.dy, app.aim.dx) + delta;
    app.aim = { dx: Math.cos(a), dy: Math.sin(a) }; app.aimDirty = true;
  }
  function tryPlace(p) {
    const s = app.state;
    let x = Math.min(W - R, Math.max(R, p.x)); const y = Math.min(H - R, Math.max(R, p.y));
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
    else {
      const c = cuePos(), vx = p.x - c.x, vy = p.y - c.y, l = Math.sqrt(vx * vx + vy * vy);
      if (l > R) { app.aim = { dx: -vx / l, dy: -vy / l }; app.aimDirty = true; }
      app.power = Math.max(0, Math.min(1, (l - R * 1.5) / 260));
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (app.drag) { canvas.style.cursor = app.drag.kind === 'place' ? 'grabbing' : 'crosshair'; return; }
    if (!canAct()) { canvas.style.cursor = 'default'; return; }
    const p = tableR.toWorld(e.clientX, e.clientY), c = cuePos();
    const d = Math.sqrt((p.x - c.x) * (p.x - c.x) + (p.y - c.y) * (p.y - c.y));
    canvas.style.cursor = app.state.ballInHand && d < R * 2.6 ? 'grab' : 'crosshair';
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

  // power slider: pull and let go
  const powerEl = $('#power'), fill = powerEl.querySelector('.power-fill'), powerOut = $('#power-out');
  const vertical = (el) => { const r = el.getBoundingClientRect(); return r.height >= r.width; };
  // Power is how far you drag, not where you press: start anywhere on the slider and pull.
  // Pulling 75% of the slider's length (or past its end) gives full power.
  const POWER_REACH = 0.75;
  let powerDrag = null;
  powerEl.addEventListener('pointerdown', (e) => {
    audio.unlock();
    if (!canAct()) return;
    capture(powerEl, e.pointerId);
    const r = powerEl.getBoundingClientRect(), vert = r.height >= r.width;
    powerDrag = { id: e.pointerId, vert, start: vert ? e.clientY : e.clientX, len: (vert ? r.height : r.width) * POWER_REACH };
    app.power = 0; app.aimDirty = true; e.preventDefault();
  });
  powerEl.addEventListener('pointermove', (e) => {
    if (!powerDrag || powerDrag.id !== e.pointerId) return;
    const pos = powerDrag.vert ? e.clientY : e.clientX;
    app.power = Math.max(0, Math.min(1, (pos - powerDrag.start) / powerDrag.len));
    app.aimDirty = true;
  });
  const endPower = (e) => {
    if (!powerDrag || powerDrag.id !== e.pointerId) return;
    powerDrag = null;
    if (e.type === 'pointerup') shoot(); else app.power = 0;
  };
  powerEl.addEventListener('pointerup', endPower);
  powerEl.addEventListener('pointercancel', endPower);
  let shownPower = -1;
  function updatePower() {
    const pct = Math.round(app.power * 100);
    if (pct === shownPower) return;
    shownPower = pct;
    if (vertical(powerEl)) { fill.style.height = pct + '%'; fill.style.width = ''; }
    else { fill.style.width = pct + '%'; fill.style.height = ''; }
    powerOut.textContent = pct;
    powerEl.setAttribute('aria-valuenow', pct);
  }

  // spin: a chalk mark on the cue ball
  const spinEl = $('#spin'), dot = spinEl.querySelector('.spin-dot');
  function updateSpin() {
    dot.style.top = (50 - app.spin * 36) + '%';
    $('#spin-label').textContent = app.spin > 0.05 ? 'Follow' : app.spin < -0.05 ? 'Draw' : 'No spin';
    spinEl.setAttribute('aria-valuenow', Math.round(app.spin * 100));
  }
  function spinFrom(e) {
    const r = spinEl.getBoundingClientRect();
    app.spin = Math.max(-1, Math.min(1, -((e.clientY - r.top) / r.height - 0.5) / 0.36));
    if (Math.abs(app.spin) < 0.12) app.spin = 0;
    updateSpin(); app.aimDirty = true;
  }
  let spinDrag = null;
  spinEl.addEventListener('pointerdown', (e) => { if (!canAct()) return; spinDrag = e.pointerId; capture(spinEl, e.pointerId); spinFrom(e); });
  spinEl.addEventListener('pointermove', (e) => { if (spinDrag === e.pointerId) spinFrom(e); });
  spinEl.addEventListener('pointerup', () => { spinDrag = null; });
  spinEl.addEventListener('dblclick', () => { app.spin = 0; updateSpin(); });

  // fine-aim wheel: drag sideways to turn the cue a hair at a time
  const wheel = $('#wheel'), ridges = wheel.querySelector('.wheel-ridges');
  let wheelDrag = null, wheelOffset = 0;
  wheel.addEventListener('pointerdown', (e) => {
    if (!canAct()) return;
    capture(wheel, e.pointerId); wheelDrag = { id: e.pointerId, x: e.clientX }; e.preventDefault();
  });
  wheel.addEventListener('pointermove', (e) => {
    if (!wheelDrag || wheelDrag.id !== e.pointerId || !canAct()) return;
    const dx = e.clientX - wheelDrag.x; wheelDrag.x = e.clientX;
    rotateAim(dx * (e.shiftKey ? 0.004 : 0.0009));
    wheelOffset += dx; ridges.style.backgroundPositionX = wheelOffset + 'px';
  });
  const endWheel = () => { wheelDrag = null; };
  wheel.addEventListener('pointerup', endWheel); wheel.addEventListener('pointercancel', endWheel);

  // keyboard
  const overlayOpen = () => !$('#rules').hidden || !$('#confirm').hidden;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('#rules').hidden) closeRules(); else if (!$('#confirm').hidden) closeConfirm(); return; }
    if (current !== 'game' || e.target.tagName === 'INPUT' || overlayOpen() || !canAct()) return;
    const step = e.shiftKey ? 0.012 : 0.002;
    if (e.key === 'ArrowLeft') { rotateAim(-step); wheelOffset -= 4; ridges.style.backgroundPositionX = wheelOffset + 'px'; e.preventDefault(); }
    else if (e.key === 'ArrowRight') { rotateAim(step); wheelOffset += 4; ridges.style.backgroundPositionX = wheelOffset + 'px'; e.preventDefault(); }
    else if (e.key === 'ArrowUp') { app.spin = Math.min(1, app.spin + 0.25); updateSpin(); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { app.spin = Math.max(-1, app.spin - 0.25); updateSpin(); e.preventDefault(); }
    else if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) { audio.unlock(); app.charging = true; app.power = 0; } }
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
      beginShot(m.start, m.input, m.result, m.score);
    });
    socket.on('aim', (a) => { if (app.state && !myTurn() && !app.anim) app.remote.aim = a; });
    socket.on('place', (p) => { if (app.state && !myTurn() && !app.anim) app.remote.place = p; });
    socket.on('shotRejected', (msg) => { app.pending = false; app.strike = null; showTag('Can’t shoot', String(msg), FOUL); updateHUD(); });
    return socket;
  }

  function onRoom(r) {
    if (app.mode !== 'online') return;
    app.code = r.code; app.seat = r.you; app.players = r.players; app.rematch = r.rematch;
    if (!app.anim && r.score) app.score = r.score.slice();
    const url = new URL(location.href); url.searchParams.set('room', r.code);
    history.replaceState(null, '', url);
    const full = r.players[0] && r.players[1];
    if (r.state && full) {
      const sameGame = r.gameId === app.gameId;
      app.gameId = r.gameId;
      if (current !== 'game') show('game');
      if (app.anim && sameGame && r.state.shotNo === app.anim.result.shotNo) { app.anim.result = r.state; if (r.score) app.anim.score = r.score.slice(); }
      else if (app.anim) { app.anim = null; setState(r.state, false); }
      else if (!sameGame || !app.state || r.state.shotNo !== app.state.shotNo) setState(r.state, false);
      else if (r.state.phase === 'over') showOver();
      updateHUD();
    } else {
      const hadGame = !!app.gameId;
      app.state = null; app.anim = null;
      $('#over').hidden = true; closeConfirm();
      renderLobby(r, hadGame);
      show('lobby');
    }
  }

  function renderLobby(r, hadGame) {
    const tiles = $('#code-tiles'); tiles.textContent = '';
    for (const ch of r.code) { const s = document.createElement('span'); s.textContent = ch; tiles.appendChild(s); }
    tiles.setAttribute('aria-label', `Room code ${r.code.split('').join(' ')}`);
    const plate = (seat) => {
      const p = r.players[seat];
      const el = $(seat ? '#mp1-plate' : '.mp0'), name = $('#mp' + seat), sub = $('#mp' + seat + '-sub');
      el.classList.toggle('waiting', !p);
      if (p) { name.textContent = p.name; sub.textContent = seat === app.seat ? (seat === 0 ? 'You, hosting' : 'You') : (seat === 0 ? 'Host' : 'Joined'); }
      else { name.textContent = 'Waiting for a player'; sub.textContent = 'Send them the code below'; }
    };
    plate(0); plate(1);
    $('#lobby-msg').textContent = app.seat < 0 ? 'You’ll be watching. The match starts when both seats are filled.'
      : hadGame ? 'Your opponent left. Send the code to someone else, or wait for them to come back.'
        : 'The match starts as soon as your friend joins.';
  }

  function goOnline(action, code) {
    const err = $('#home-error'); err.textContent = '';
    const name = myName(); store.set('pool.name', $('#name').value.trim());
    const s = ensureSocket();
    if (!s) { err.textContent = 'Online play needs the game server. Open the game from its web address.'; return; }
    const btns = $$('#home .btn'); btns.forEach((b) => (b.disabled = true));
    const done = () => btns.forEach((b) => (b.disabled = false));
    const timer = setTimeout(() => { done(); err.textContent = 'The server is still waking up. Try again in a few seconds.'; }, 20000);
    const ack = (res) => {
      clearTimeout(timer); done();
      if (!res || !res.ok) { app.mode = null; err.textContent = (res && res.error) || 'Something went wrong. Try again.'; return; }
      app.code = res.code; session.set('pool.room', res.code);
    };
    app.mode = 'online'; app.gameId = 0; app.state = null; app.score = [0, 0];
    if (action === 'create') s.emit('create', { name, clientId }, ack);
    else s.emit('join', { code, name, clientId }, ack);
  }

  function leaveToHome(msg) {
    if (app.mode === 'online' && socket) socket.emit('leave');
    app.mode = null; app.code = null; app.state = null; app.anim = null; app.gameId = 0; app.pending = false; app.score = [0, 0];
    session.del('pool.room');
    $('#over').hidden = true; closeConfirm();
    const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState(null, '', url);
    $('#home-error').textContent = msg || '';
    show('home');
  }

  function startLocal() {
    audio.unlock();
    store.set('pool.name', $('#name').value.trim()); store.set('pool.name2', $('#name2').value.trim());
    app.mode = 'local'; app.seat = 0; app.score = [0, 0]; app.localBreaker = 0;
    app.localNames = [myName(), $('#name2').value.trim().slice(0, 16) || 'Player 2'];
    show('game');
    setState(C.newGame(0), false);
  }

  // ------------------------------------------------------------------ home: tabs and code boxes
  function selectTab(which) {
    const online = which === 'online';
    $('#tab-online').setAttribute('aria-selected', String(online));
    $('#tab-local').setAttribute('aria-selected', String(!online));
    $('#pane-online').hidden = !online; $('#pane-local').hidden = online;
    $('#home-error').textContent = '';
  }
  $('#tab-online').addEventListener('click', () => selectTab('online'));
  $('#tab-local').addEventListener('click', () => selectTab('local'));
  $('.seg').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = $('#tab-online').getAttribute('aria-selected') === 'true' ? 'local' : 'online';
    selectTab(next); $('#tab-' + next).focus();
  });

  const cells = $$('.code-cell');
  const readCode = () => cells.map((c) => c.value).join('');
  function fillCode(str, from) {
    const letters = str.toUpperCase().replace(/[^A-Z]/g, '').split('');
    let i = from || 0;
    for (const ch of letters) { if (i > 3) break; cells[i].value = ch; i++; }
    cells[Math.min(i, 3)].focus();
    if (readCode().length === 4) $('#btn-join').focus();
  }
  cells.forEach((cell, i) => {
    cell.addEventListener('input', () => {
      const v = cell.value.toUpperCase().replace(/[^A-Z]/g, '');
      cell.value = '';
      if (v) fillCode(v, i);
    });
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !cell.value && i > 0) { cells[i - 1].value = ''; cells[i - 1].focus(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' && i > 0) { cells[i - 1].focus(); e.preventDefault(); }
      else if (e.key === 'ArrowRight' && i < 3) { cells[i + 1].focus(); e.preventDefault(); }
    });
    cell.addEventListener('paste', (e) => { e.preventDefault(); fillCode((e.clipboardData || window.clipboardData).getData('text'), i); });
    cell.addEventListener('focus', () => cell.select());
  });

  $('#btn-create').addEventListener('click', () => { audio.unlock(); goOnline('create'); });
  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault(); audio.unlock();
    const code = readCode();
    if (!/^[A-Z]{4}$/.test(code)) { $('#home-error').textContent = 'Room codes are 4 letters. Check the code your friend sent.'; (cells.find((c) => !c.value) || cells[0]).focus(); return; }
    goOnline('join', code);
  });
  $('#btn-local').addEventListener('click', startLocal);

  // ------------------------------------------------------------------ lobby and game buttons
  const inviteLink = () => `${location.origin}${location.pathname}?room=${app.code}`;
  async function copyInvite(btn) {
    try {
      await navigator.clipboard.writeText(inviteLink());
      if (btn) { const label = btn.querySelector('span'); const was = label.textContent; label.textContent = 'Link copied'; setTimeout(() => (label.textContent = was), 1800); }
      else showTag('Invite', 'Link copied. Send it to a friend.', '#F5F7FB');
    } catch (e) {
      if (btn) btn.querySelector('span').textContent = inviteLink();
      else showTag('Invite', inviteLink(), '#F5F7FB');
    }
  }
  $('#btn-copy').addEventListener('click', () => copyInvite($('#btn-copy')));
  if (navigator.share) $('#btn-share').hidden = false;
  $('#btn-share').addEventListener('click', () => {
    navigator.share({ title: 'Play pool with me', text: `Join my pool match. Room code ${app.code}.`, url: inviteLink() }).catch(() => {});
  });
  $('#room-chip').addEventListener('click', () => copyInvite(null));
  $('#lobby-leave').addEventListener('click', () => leaveToHome());

  function requestLeave() {
    const s = app.state;
    const playing = s && s.phase !== 'over' && s.shotNo > 0 && (app.mode === 'local' || app.seat >= 0);
    if (playing) openConfirm(); else leaveToHome();
  }
  let confirmReturn = null;
  function openConfirm() { confirmReturn = document.activeElement; $('#confirm').hidden = false; $('#confirm-stay').focus(); }
  function closeConfirm() { if ($('#confirm').hidden) return; $('#confirm').hidden = true; if (confirmReturn) confirmReturn.focus(); }
  $('#btn-leave').addEventListener('click', requestLeave);
  $('#confirm-leave').addEventListener('click', () => leaveToHome());
  $('#confirm-stay').addEventListener('click', closeConfirm);
  $('#confirm').addEventListener('click', (e) => { if (e.target.id === 'confirm') closeConfirm(); });
  $('#btn-over-leave').addEventListener('click', () => leaveToHome());
  $('#btn-rematch').addEventListener('click', () => {
    if (app.mode === 'local') {
      app.localBreaker = 1 - app.localBreaker;
      $('#over').hidden = true;
      setState(C.newGame(app.localBreaker), false);
    } else if (socket) { socket.emit('rematch'); $('#btn-rematch').disabled = true; $('#btn-rematch').textContent = 'Waiting for opponent…'; }
  });

  let rulesReturn = null;
  function openRules() { rulesReturn = document.activeElement; $('#rules').hidden = false; $('#rules-close').focus(); }
  function closeRules() { $('#rules').hidden = true; if (rulesReturn) rulesReturn.focus(); }
  $('#btn-rules').addEventListener('click', openRules);
  $('#home-rules').addEventListener('click', openRules);
  $('#rules-close').addEventListener('click', closeRules);
  $('#rules').addEventListener('click', (e) => { if (e.target.id === 'rules') closeRules(); });

  const soundBtn = $('#btn-sound');
  function syncSound() {
    soundBtn.setAttribute('aria-pressed', String(audio.on));
    soundBtn.querySelector('use').setAttribute('href', audio.on ? '#i-sound' : '#i-mute');
    soundBtn.querySelector('span').textContent = audio.on ? 'Sound on' : 'Sound off';
    soundBtn.setAttribute('aria-label', audio.on ? 'Sound on' : 'Sound off');
  }
  soundBtn.addEventListener('click', () => { audio.on = !audio.on; store.set('pool.sound', audio.on ? 'on' : 'off'); audio.unlock(); syncSound(); });
  syncSound();

  // ------------------------------------------------------------------ attract mode (home backdrop)
  const attract = { state: null, sim: null, wait: 0, shots: 0, pots: [], aim: { dx: 1, dy: 0 }, power: 0, strikeAt: 0 };
  let attractSeed = 5;
  const attractRand = () => (attractSeed = (attractSeed * 16807) % 2147483647) / 2147483647;
  function attractReset() { resetAll(attractR.orient); attract.state = C.newGame(0, attractRand); attract.sim = null; attract.shots = 0; attract.wait = 1.6; attract.aim = { dx: 1, dy: 0 }; attract.power = 0.95; }
  function attractPlan() {
    const s = attract.state, cue = s.balls.find((b) => b.n === 0);
    if (attract.shots === 0) { attract.aim = { dx: 1, dy: (attractRand() - 0.5) * 0.02 }; attract.power = 0.95; return; }
    const targets = s.balls.filter((b) => !b.in && b.n !== 0);
    const t = targets[Math.floor(attractRand() * targets.length)];
    let dx = t.x - cue.x, dy = t.y - cue.y; const l = Math.sqrt(dx * dx + dy * dy) || 1;
    const err = (attractRand() - 0.5) * 0.08;
    dx /= l; dy /= l;
    attract.aim = { dx: dx * Math.cos(err) - dy * Math.sin(err), dy: dx * Math.sin(err) + dy * Math.cos(err) };
    attract.power = 0.35 + attractRand() * 0.3;
  }
  function attractStep(dt, now) {
    if (!attract.state) attractReset();
    if (reduceMotion) return;
    if (attract.sim) {
      attract.acc = (attract.acc || 0) + dt;
      let steps = Math.floor(attract.acc / C.DT); attract.acc -= steps * C.DT;
      let ran = 0;
      while (steps-- > 0 && !attract.sim.done) { C.stepSim(attract.sim); ran++; }
      rollBalls(attractR.orient, attract.sim.balls, ran * C.DT);
      for (const e of attract.sim.events) if (e.t === 'pocket') attract.pots.push({ n: e.n, x: e.x, y: e.y, p: e.p, t0: now });
      attract.sim.events.length = 0;
      if (attract.sim.done) {
        const byN = {}; for (const b of attract.sim.balls) byN[b.n] = b;
        for (const b of attract.state.balls) { const s = byN[b.n]; if (s) { b.x = s.x; b.y = s.y; b.in = s.in; } }
        const cue = attract.state.balls[0];
        if (cue.in) { cue.in = false; cue.x = HEAD_X; cue.y = H / 2; if (!C.placementOk(attract.state.balls, cue.x, cue.y, false)) cue.y = H * 0.25; }
        attract.sim = null; attract.shots++;
        const left = attract.state.balls.filter((b) => !b.in && b.n !== 0).length;
        if (attract.shots >= 5 || left < 5) { attract.wait = 2.4; attract.resetAfter = true; }
        else { attract.wait = 1.5; attractPlan(); }
      }
    } else {
      attract.wait -= dt;
      if (attract.wait <= 0) {
        if (attract.resetAfter) { attract.resetAfter = false; attractReset(); return; }
        const s = attract.state;
        const cb = s.balls.find((x) => x.n === 0);
        attract.sim = C.createSim(s, { dx: attract.aim.dx, dy: attract.aim.dy, power: attract.power, spin: 0, cue: null });
        attract.strikeAt = now; attract.strikeX = cb.x; attract.strikeY = cb.y;
      }
    }
  }
  function attractRender(now) {
    const r = attractR, ctx = r.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, r.canvas.width, r.canvas.height);
    if (!r.layer || !attract.state) return;
    ctx.drawImage(r.layer, 0, 0);
    r.worldTransform();
    const balls = (attract.sim ? attract.sim.balls : attract.state.balls).filter((b) => !b.in);
    for (const b of balls) drawShadow(r, b.x, b.y);
    for (const b of balls) drawBall(r, b.n, b.x, b.y);
    attract.pots = attract.pots.filter((a) => now - a.t0 < 0.24);
    drawPotAnims(r, attract.pots, now);
    const cue = balls.find((b) => b.n === 0);
    if (cue && !attract.resetAfter) {
      if (!attract.sim) {
        const pull = Math.max(0, Math.min(1, 1 - attract.wait / 1.2)); // draw the cue back before striking
        drawCue(r, cue.x, cue.y, attract.aim.dx, attract.aim.dy, R + 6 + pull * attract.power * 70, Math.min(1, (1.6 - attract.wait) * 3), PLAYER[0]);
      } else if (now - attract.strikeAt < 0.3) {
        drawCue(r, attract.strikeX, attract.strikeY, attract.aim.dx, attract.aim.dy, R + 1 - (now - attract.strikeAt) * 30, 1 - (now - attract.strikeAt) / 0.3, PLAYER[0]);
      }
    }
  }

  // The opponent's aim arrives ~20 times a second; ease toward it so their cue glides.
  function smoothRemote(dt) {
    const rm = app.remote, f = 1 - Math.exp(-dt * 16);
    if (rm.aim) {
      const target = Math.atan2(rm.aim.dy, rm.aim.dx);
      if (!rm.view) rm.view = { ang: target, power: rm.aim.power };
      else {
        let d = target - rm.view.ang;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        rm.view.ang += d * f;
        rm.view.power += (rm.aim.power - rm.view.power) * f;
      }
    }
    if (rm.place) {
      if (!rm.placeView) rm.placeView = { x: rm.place.x, y: rm.place.y };
      else { rm.placeView.x += (rm.place.x - rm.placeView.x) * f; rm.placeView.y += (rm.place.y - rm.placeView.y) * f; }
    }
  }

  // ------------------------------------------------------------------ loop
  let last = performance.now() / 1000;
  function frame(t) {
    const now = t / 1000;
    let dt = now - last; last = now;
    audio.budget = 6;
    if (dt > 0.3) { // back from a background tab: jump to the end of any shot
      if (app.anim) { while (!app.anim.sim.done) C.stepSim(app.anim.sim); finishShot(); }
      if (attract.sim) { while (!attract.sim.done) C.stepSim(attract.sim); }
      dt = 0;
    }
    if (app.charging && canAct()) { app.power = Math.min(1, app.power + dt / 1.3); app.aimDirty = true; }
    if (app.anim) stepAnim(dt, now);
    smoothRemote(dt);
    if (app.mode === 'online' && socket && canAct() && now - app.lastSend > 0.05) {
      if (app.aimDirty) { socket.volatile.emit('aim', { dx: app.aim.dx, dy: app.aim.dy, power: app.power, spin: app.spin }); app.aimDirty = false; app.lastSend = now; }
      if (app.placeDirty && app.place) { socket.volatile.emit('place', app.place); app.placeDirty = false; app.lastSend = now; }
    }
    if (current === 'game') {
      render(tableR, now);
      updatePower();
      if ($('#dock').classList.contains('idle') !== !canAct()) updateHUD();
    } else if (current === 'home') {
      attractStep(dt, now);
      attractRender(now);
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ boot
  new ResizeObserver(() => { if (current === 'game') { tableR.resize(); shownPower = -1; } }).observe($('#table-wrap'));
  new ResizeObserver(() => { if (current === 'home') attractR.resize(); }).observe($('.attract'));
  buildGlyphs();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { buildGlyphs(); tableR.resize(); attractR.resize(); });
  $('#name').value = store.get('pool.name') || '';
  $('#name2').value = store.get('pool.name2') || '';
  const params = new URLSearchParams(location.search);
  const roomParam = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (roomParam) { selectTab('online'); roomParam.split('').forEach((ch, i) => (cells[i].value = ch)); }
  attractReset();
  attractR.resize();
  updateSpin();
  requestAnimationFrame(frame);
  if (typeof window.io === 'function') {
    ensureSocket();
    // a reload drops you straight back into the room you were in
    if (roomParam && session.get('pool.room') === roomParam) goOnline('join', roomParam);
  }
  window.__pool = { app, C, tableR, setState }; // handy for debugging in the console
})();
