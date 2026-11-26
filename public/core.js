/* Pool core: table geometry, deterministic physics and 8-ball rules.
 * Shared by the server (authoritative) and the browser (animation + local play).
 * The simulation uses only + - * / and Math.sqrt so it gives identical
 * results on every JS engine. Never add Math.sin/cos/pow/hypot in here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PoolCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- table geometry (world units; play area is W x H) ----------
  const W = 1000, H = 500, R = 12;
  const DT = 1 / 600;                 // physics step (s)
  const MAX_SPEED = 3300, MIN_SPEED = 30;
  // Each ball has a velocity (vx, vy) and a rolling velocity (rx, ry) = spin x radius.
  // While they differ the ball skids and sliding friction pulls them together;
  // once equal it rolls and only the much smaller rolling friction applies.
  const SLIDE_DECEL = 560;            // sliding friction (u/s^2), fast cloth mu ~0.15
  const ROLL_DECEL = 62;              // rolling resistance (u/s^2)
  const DRAG = 0.07;                  // gentle speed-proportional loss (1/s)
  const SPIN_GAIN = 1.4;              // how hard the spin control bites
  const BALL_REST = 0.96, RAIL_REST = 0.8, RAIL_GRIP = 0.975, RAIL_SPIN_KEEP = 0.45;
  const SLIP_EPS = 1.5, STOP_SPEED = 2.5;
  const HEAD_X = W * 0.25, FOOT_X = W * 0.75;
  const CM = 30, SM = 22;             // corner / side pocket mouth sizes

  const POCKETS = [
    { x: -6, y: -6, r: 25 }, { x: W / 2, y: -14, r: 22 }, { x: W + 6, y: -6, r: 25 },
    { x: -6, y: H + 6, r: 25 }, { x: W / 2, y: H + 14, r: 22 }, { x: W + 6, y: H + 6, r: 25 },
  ];

  // Cushion boundary as one closed path (play area + pocket channels).
  // Consecutive points form cushion segments, except across pocket mouths.
  const BOUNDARY = [
    // top rail, left to right
    [CM, 0, 'seg'], [W / 2 - SM, 0, 'seg'], [W / 2 - SM + 5, -15, 'gap'],
    [W / 2 + SM - 5, -15, 'seg'], [W / 2 + SM, 0, 'seg'], [W - CM, 0, 'seg'], [W - CM + 16, -16, 'gap'],
    // right rail
    [W + 16, CM - 16, 'seg'], [W, CM, 'seg'], [W, H - CM, 'seg'], [W + 16, H - CM + 16, 'gap'],
    // bottom rail, right to left
    [W - CM + 16, H + 16, 'seg'], [W - CM, H, 'seg'], [W / 2 + SM, H, 'seg'], [W / 2 + SM - 5, H + 15, 'gap'],
    [W / 2 - SM + 5, H + 15, 'seg'], [W / 2 - SM, H, 'seg'], [CM, H, 'seg'], [CM - 16, H + 16, 'gap'],
    // left rail
    [-16, H - CM + 16, 'seg'], [0, H - CM, 'seg'], [0, CM, 'seg'], [-16, CM - 16, 'gap'],
    [CM - 16, -16, 'seg'],
  ];
  const SEGMENTS = [];
  for (let i = 0; i < BOUNDARY.length; i++) {
    const a = BOUNDARY[i], b = BOUNDARY[(i + 1) % BOUNDARY.length];
    if (a[2] === 'seg') SEGMENTS.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1] });
  }

  const SOLIDS = 'solids', STRIPES = 'stripes';
  function groupOf(n) {
    if (n >= 1 && n <= 7) return SOLIDS;
    if (n >= 9 && n <= 15) return STRIPES;
    if (n === 8) return 'eight';
    return 'cue';
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ---------- setup ----------
  function rackPositions() {
    const pos = [], g = 2 * R + 0.02, rowDx = g * Math.sqrt(3) / 2;
    for (let k = 0; k < 5; k++)
      for (let i = 0; i <= k; i++)
        pos.push({ x: FOOT_X + k * rowDx, y: H / 2 + (i - k / 2) * g });
    return pos; // index 4 is the centre of row 3; 10 and 14 are the back corners
  }

  function newGame(breaker, rand) {
    rand = rand || Math.random;
    const pos = rackPositions();
    const solids = [1, 2, 3, 4, 5, 6, 7], stripes = [9, 10, 11, 12, 13, 14, 15];
    const take = (arr) => arr.splice(Math.floor(rand() * arr.length), 1)[0];
    const order = new Array(15);
    order[4] = 8;
    const cornerSolid = take(solids), cornerStripe = take(stripes);
    if (rand() < 0.5) { order[10] = cornerSolid; order[14] = cornerStripe; }
    else { order[10] = cornerStripe; order[14] = cornerSolid; }
    const rest = solids.concat(stripes);
    for (let i = 0; i < 15; i++) if (order[i] === undefined) order[i] = take(rest);
    const balls = [{ n: 0, x: HEAD_X, y: H / 2, in: false }];
    for (let i = 0; i < 15; i++) balls.push({ n: order[i], x: pos[i].x, y: pos[i].y, in: false });
    return {
      v: 1, balls, turn: breaker, breaker, groups: [null, null],
      phase: 'break', ballInHand: true, kitchen: true, winner: null,
      lastShot: null, shotNo: 0,
    };
  }

  // ---------- placement helpers ----------
  function placementOk(balls, x, y, kitchen) {
    if (!(x >= R && x <= W - R && y >= R && y <= H - R)) return false;
    if (kitchen && x > HEAD_X) return false;
    for (const b of balls) {
      if (b.in || b.n === 0) continue;
      const dx = b.x - x, dy = b.y - y;
      if (dx * dx + dy * dy < 4 * R * R + 0.01) return false;
    }
    return true;
  }

  function freeSpot(balls, x, y, kitchen) {
    if (placementOk(balls, x, y, kitchen)) return { x, y };
    for (let ring = 1; ring < 60; ring++) {
      for (let a = 0; a < 16; a++) {
        const ang = a * Math.PI / 8; // only used on the server/local, result is stored
        const px = x + Math.cos(ang) * ring * 6, py = y + Math.sin(ang) * ring * 6;
        if (placementOk(balls, px, py, kitchen)) return { x: px, y: py };
      }
    }
    return { x: R + 1, y: R + 1 };
  }

  // ---------- simulation ----------
  function shotSpeed(power) {
    return MIN_SPEED + (MAX_SPEED - MIN_SPEED) * (0.45 * power + 0.55 * power * power);
  }

  function createSim(state, input) {
    const balls = state.balls.filter((b) => !b.in).map((b) => ({
      n: b.n, x: b.x, y: b.y, vx: 0, vy: 0, rx: 0, ry: 0, in: false,
    }));
    const cue = balls.find((b) => b.n === 0);
    if (cue && input.cue) { cue.x = input.cue.x; cue.y = input.cue.y; }
    const sp = shotSpeed(input.power);
    if (cue) {
      // centre hit = pure skid (stun); above centre = topspin (follow); below = backspin (draw)
      const k = SPIN_GAIN * (input.spin || 0);
      cue.vx = input.dx * sp; cue.vy = input.dy * sp;
      cue.rx = cue.vx * k; cue.ry = cue.vy * k;
    }
    return {
      balls, steps: 0, done: false, events: [],
      firstHit: null, railAfterHit: false, potted: [], cuePotted: false,
    };
  }

  function stepSim(sim) {
    if (sim.done) return;
    const bs = sim.balls, n = bs.length, R2 = 4 * R * R;
    // integrate
    for (let i = 0; i < n; i++) {
      const b = bs[i];
      if (b.in) continue;
      b.x += b.vx * DT; b.y += b.vy * DT;
    }
    // ball-ball
    for (let i = 0; i < n; i++) {
      const a = bs[i];
      if (a.in) continue;
      for (let j = i + 1; j < n; j++) {
        const b = bs[j];
        if (b.in) continue;
        const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 >= R2) continue;
        let d = Math.sqrt(d2), nx, ny;
        if (d < 1e-9) { nx = 1; ny = 0; d = 0; } else { nx = dx / d; ny = dy / d; }
        const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        const ov = (2 * R - d) / 2;
        a.x -= nx * ov; a.y -= ny * ov; b.x += nx * ov; b.y += ny * ov;
        if (rel <= 0) continue;
        // balls exchange velocity along the line of centres; their spin stays put
        const J = (1 + BALL_REST) / 2 * rel;
        a.vx -= J * nx; a.vy -= J * ny; b.vx += J * nx; b.vy += J * ny;
        sim.events.push({ t: 'ball', s: rel });
        if (sim.firstHit === null && (a.n === 0 || b.n === 0)) sim.firstHit = a.n === 0 ? b.n : a.n;
      }
    }
    // cushions
    for (let i = 0; i < n; i++) {
      const b = bs[i];
      if (b.in) continue;
      for (let s = 0; s < SEGMENTS.length; s++) {
        const g = SEGMENTS[s];
        const ex = g.bx - g.ax, ey = g.by - g.ay;
        let t = ((b.x - g.ax) * ex + (b.y - g.ay) * ey) / (ex * ex + ey * ey);
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const px = g.ax + ex * t, py = g.ay + ey * t;
        const dx = b.x - px, dy = b.y - py, d2 = dx * dx + dy * dy;
        if (d2 >= R * R || d2 < 1e-12) continue;
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        b.x = px + nx * R; b.y = py + ny * R;
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) {
          const tx = b.vx - vn * nx, ty = b.vy - vn * ny;
          b.vx = tx * RAIL_GRIP - vn * RAIL_REST * nx;
          b.vy = ty * RAIL_GRIP - vn * RAIL_REST * ny;
          // the cushion nose sits above the ball's centre, so it partly reverses roll into it
          const rn = b.rx * nx + b.ry * ny, rtx = b.rx - rn * nx, rty = b.ry - rn * ny;
          b.rx = rtx * RAIL_GRIP - rn * RAIL_SPIN_KEEP * nx;
          b.ry = rty * RAIL_GRIP - rn * RAIL_SPIN_KEEP * ny;
          sim.events.push({ t: 'rail', s: -vn });
          if (sim.firstHit !== null) sim.railAfterHit = true;
        }
      }
    }
    // pockets
    for (let i = 0; i < n; i++) {
      const b = bs[i];
      if (b.in) continue;
      let hit = -1;
      for (let p = 0; p < POCKETS.length; p++) {
        const pk = POCKETS[p], dx = b.x - pk.x, dy = b.y - pk.y;
        if (dx * dx + dy * dy < pk.r * pk.r) { hit = p; break; }
      }
      if (hit < 0 && (b.x < -20 || b.x > W + 20 || b.y < -20 || b.y > H + 20)) {
        let best = 1e18;
        for (let p = 0; p < POCKETS.length; p++) {
          const pk = POCKETS[p], dx = b.x - pk.x, dy = b.y - pk.y, d2 = dx * dx + dy * dy;
          if (d2 < best) { best = d2; hit = p; }
        }
      }
      if (hit >= 0) {
        b.in = true; b.pocket = hit; b.vx = 0; b.vy = 0; b.rx = 0; b.ry = 0;
        if (b.n === 0) sim.cuePotted = true; else sim.potted.push(b.n);
        sim.events.push({ t: 'pocket', n: b.n, p: hit, x: b.x, y: b.y });
      }
    }
    // friction: skid until spin matches travel, then roll
    let moving = false;
    const slideStep = SLIDE_DECEL * DT;
    for (let i = 0; i < n; i++) {
      const b = bs[i];
      if (b.in) continue;
      const sx = b.vx - b.rx, sy = b.vy - b.ry, slip = Math.sqrt(sx * sx + sy * sy);
      if (slip > SLIP_EPS) {
        if (3.5 * slideStep >= slip) {
          // the skid ends this step: 5v + 2r is conserved, so this is the rolling speed
          const fx = (5 * b.vx + 2 * b.rx) / 7, fy = (5 * b.vy + 2 * b.ry) / 7;
          b.vx = fx; b.vy = fy; b.rx = fx; b.ry = fy;
        } else {
          const ux = sx / slip, uy = sy / slip;
          b.vx -= ux * slideStep; b.vy -= uy * slideStep;
          b.rx += 2.5 * ux * slideStep; b.ry += 2.5 * uy * slideStep;
        }
        moving = true;
        continue;
      }
      const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (sp === 0) { b.rx = 0; b.ry = 0; continue; }
      const ns = sp - (ROLL_DECEL + DRAG * sp) * DT;
      if (ns <= 0) { b.vx = 0; b.vy = 0; b.rx = 0; b.ry = 0; continue; }
      const k = ns / sp;
      b.vx *= k; b.vy *= k; b.rx = b.vx; b.ry = b.vy;
      if (ns > STOP_SPEED) moving = true;
    }
    sim.steps++;
    if (!moving || sim.steps > 600 * 45) {
      for (let i = 0; i < n; i++) { bs[i].vx = 0; bs[i].vy = 0; bs[i].rx = 0; bs[i].ry = 0; }
      sim.done = true;
    }
  }

  function runSim(sim) { while (!sim.done) stepSim(sim); return sim; }

  // ---------- input validation ----------
  function normalizeInput(state, raw) {
    if (!raw || typeof raw !== 'object') return { error: 'Bad shot' };
    let dx = Number(raw.dx), dy = Number(raw.dy);
    let power = Number(raw.power), spin = Number(raw.spin) || 0;
    if (!isFinite(dx) || !isFinite(dy) || !isFinite(power)) return { error: 'Bad shot' };
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-6) return { error: 'Bad aim' };
    dx /= len; dy /= len;
    power = Math.min(1, Math.max(0, power));
    spin = isFinite(spin) ? Math.min(1, Math.max(-1, spin)) : 0;
    let cue = null;
    if (state.ballInHand && raw.cue && isFinite(raw.cue.x) && isFinite(raw.cue.y)) {
      const x = Number(raw.cue.x), y = Number(raw.cue.y);
      if (!placementOk(state.balls, x, y, state.kitchen)) return { error: 'The cue ball can’t go there' };
      cue = { x, y };
    }
    return { input: { dx, dy, power, spin, cue } };
  }

  // ---------- rules (8-ball) ----------
  function remaining(state, group) {
    return state.balls.filter((b) => !b.in && groupOf(b.n) === group).length;
  }

  function evaluate(before, sim) {
    const st = clone(before);
    const me = before.turn, opp = 1 - me;
    const isBreak = before.phase === 'break';
    const myGroup = before.groups[me];
    const onEight = !!myGroup && remaining(before, myGroup) === 0;

    // copy final positions back
    const byN = {};
    for (const b of sim.balls) byN[b.n] = b;
    for (const b of st.balls) {
      const s = byN[b.n];
      if (s) { b.x = s.x; b.y = s.y; b.in = s.in; }
    }

    const potted = sim.potted.slice();
    let foul = null;
    if (sim.firstHit === null) foul = 'No ball hit';
    else if (!isBreak) {
      if (!myGroup) { if (sim.firstHit === 8) foul = 'Hit the 8 first'; }
      else if (onEight) { if (sim.firstHit !== 8) foul = 'Didn’t hit the 8 first'; }
      else if (groupOf(sim.firstHit) !== myGroup) foul = 'Hit the wrong group first';
    }
    if (!foul && !isBreak && potted.length === 0 && !sim.railAfterHit) foul = 'No ball hit a cushion';
    if (sim.cuePotted) foul = 'Scratch';

    const shot = { by: me, potted, foul, assigned: null, continued: false, eightSpotted: false, reason: null };
    st.shotNo = before.shotNo + 1;
    st.phase = 'play';

    // the 8-ball
    if (potted.indexOf(8) >= 0) {
      if (isBreak) {
        const eight = st.balls.find((b) => b.n === 8);
        const others = st.balls.filter((b) => b.n !== 8 && !b.in);
        const clear = (x) => others.every((b) => (b.x - x) * (b.x - x) + (b.y - H / 2) * (b.y - H / 2) >= 4 * R * R + 0.01);
        let x = FOOT_X;
        while (x < W - R && !clear(x)) x += 1;
        eight.x = x; eight.y = H / 2; eight.in = false;
        shot.eightSpotted = true;
        shot.potted = potted.filter((n) => n !== 8);
      } else {
        st.phase = 'over';
        if (onEight && !foul) { st.winner = me; shot.reason = 'Potted the 8'; }
        else {
          st.winner = opp;
          shot.reason = foul ? (foul === 'Scratch' ? 'Scratched on the 8' : 'Fouled on the 8')
            : 'Potted the 8 too early';
        }
      }
    }

    if (st.phase !== 'over') {
      const objPotted = shot.potted.filter((n) => n !== 8);
      if (!foul && !isBreak && !myGroup && objPotted.length) {
        const g = groupOf(objPotted[0]);
        st.groups[me] = g; st.groups[opp] = g === SOLIDS ? STRIPES : SOLIDS;
        shot.assigned = g;
      }
      const g = st.groups[me];
      if (!foul) {
        if (isBreak) shot.continued = objPotted.length > 0;
        else if (g) shot.continued = objPotted.some((n) => groupOf(n) === g);
      }
      if (foul) {
        st.turn = opp; st.ballInHand = true; st.kitchen = isBreak;
        const cue = st.balls.find((b) => b.n === 0);
        if (cue.in) {
          const spot = freeSpot(st.balls, HEAD_X, H / 2, st.kitchen);
          cue.x = spot.x; cue.y = spot.y; cue.in = false;
        }
      } else {
        st.ballInHand = false; st.kitchen = false;
        if (!shot.continued) st.turn = opp;
      }
    } else {
      st.ballInHand = false;
    }
    st.lastShot = shot;
    return st;
  }

  // Server/local entry point: validate, simulate, apply rules.
  function applyShot(state, raw) {
    if (!state || state.phase === 'over') return { ok: false, error: 'Game is over' };
    const norm = normalizeInput(state, raw);
    if (norm.error) return { ok: false, error: norm.error };
    const sim = runSim(createSim(state, norm.input));
    return { ok: true, input: norm.input, state: evaluate(state, sim), steps: sim.steps };
  }

  return {
    W, H, R, DT, HEAD_X, FOOT_X, POCKETS, BOUNDARY, SEGMENTS, SOLIDS, STRIPES,
    groupOf, newGame, placementOk, createSim, stepSim, runSim, evaluate,
    applyShot, normalizeInput, remaining, shotSpeed, clone,
  };
});
