// May May's skeleton: poses in "cat frame" (x = forward, y = up, z = cat's left / camera side),
// blended along a timeline and resolved into world-space uniforms for the SDF shader.
window.CatRig = (function () {
  // ---------- math ----------
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a) => mul(a, 1 / (len(a) || 1));
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
  const easeIO = (x) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  const range = (t, a, b) => clamp01((t - a) / (b - a));

  // row-major 3x3
  const mm = (A, B) => {
    const C = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
      C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    return C;
  };
  const mv = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
  const tr = (M) => [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];
  const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 1, 0, s, 0, c]; };
  const rotZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; };
  const rotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; };

  // ---------- camera (design space 1440x900) ----------
  function makeCamera({ P, T, f, cx, cy }) {
    const F = norm(sub(T, P));
    const R = norm(cross(F, [0, 1, 0]));
    const U = cross(R, F);
    return { P, F, R, U, f, cx, cy };
  }
  // home camera: world origin lands on design point (860, 800), 1 unit ≈ 165px
  const CAM = (() => {
    const c = makeCamera({ P: [0, 2.2, 15], T: [0, 1.25, 0], f: 2475, cx: 860, cy: 0 });
    const v = sub([0, 0, 0], c.P);
    c.cy = 800 + (c.f * dot(v, c.U)) / dot(v, c.F);
    return c;
  })();
  function project(w, cam = CAM) {
    const v = sub(w, cam.P);
    const z = dot(v, cam.F);
    return [cam.cx + (cam.f * dot(v, cam.R)) / z, cam.cy - (cam.f * dot(v, cam.U)) / z, z];
  }
  // screen point -> world point on the plane z = planeZ
  function unproject(sx, sy, cam, planeZ = 0) {
    const d = norm(add(add(cam.F, mul(cam.R, (sx - cam.cx) / cam.f)), mul(cam.U, -(sy - cam.cy) / cam.f)));
    const t = (planeZ - cam.P[2]) / d[2];
    return add(cam.P, mul(d, t));
  }

  // ---------- skeleton constants ----------
  const HIP = {
    FL: [0.58, -0.40, 0.34], FR: [0.58, -0.40, -0.34],
    BL: [-0.58, -0.36, 0.38], BR: [-0.58, -0.36, -0.38],
  };
  const LEGS = ['FL', 'FR', 'BL', 'BR'];
  const REST = {
    FL: [0.66, 0.14, 0.34], FR: [0.66, 0.14, -0.34],
    BL: [-0.60, 0.14, 0.38], BR: [-0.60, 0.14, -0.38],
  };
  const L1 = 0.42, L2 = 0.42;

  function hipsOf(torso, pitch, squashY = 1) {
    const M = rotZ(pitch);
    const o = {};
    for (const k of LEGS) {
      const h = HIP[k];
      o[k] = add(torso, mv(M, [h[0], h[1] * squashY, h[2]]));
    }
    return o;
  }
  const tailFrom = (torso, rel) => rel.map((p) => add(torso, p));

  const TAIL_LOW = [[-0.92, -0.12, -0.2], [-1.15, -0.3, -0.52], [-1.2, -0.22, -0.86], [-1.05, -0.05, -1.1]];
  const TAIL_UP = [[-0.95, 0.1, 0], [-1.28, 0.36, 0], [-1.38, 0.72, 0.02], [-1.2, 1.0, 0.05]];
  const TAIL_SIT = [[-0.7, 0.25, 0.02], [-0.99, 0.17, 0.42], [-0.62, 0.15, 0.8], [0.03, 0.15, 0.88]];

  // ---------- base poses ----------
  function stand() {
    const torso = [0, 1.34, 0];
    return {
      torso, pitch: 0, wig: 0, squash: [1, 1, 1],
      head: [0.91, 2.42, 0], hYaw: 0.33, hPitch: -0.04, hRoll: 0,
      paws: { FL: REST.FL, FR: REST.FR, BL: REST.BL, BR: REST.BR },
      tail: tailFrom(torso, TAIL_LOW),
      earL: 0, earR: 0, blink: 0, happy: 0, tongue: 0, mouth: 0, cap: 0,
    };
  }
  function sit() {
    return {
      torso: [0.05, 0.92, 0], pitch: 0.55, wig: 0, squash: [1, 1, 1],
      head: [0.68, 2.52, 0], hYaw: 0.45, hPitch: -0.02, hRoll: 0,
      paws: { FL: [0.85, 0.14, 0.27], FR: [0.85, 0.14, -0.27], BL: [0.31, 0.14, 0.48], BR: [0.31, 0.14, -0.48] },
      tail: TAIL_SIT.map((p) => p.slice()),
      earL: 0, earR: 0, blink: 0, happy: 0, tongue: 0, mouth: 0, cap: 0,
    };
  }

  function mix(a, b, t) {
    if (typeof a === 'number') return lerp(a, b, t);
    if (Array.isArray(a)) return a.map((v, i) => mix(v, b[i], t));
    const o = {};
    for (const k in a) o[k] = mix(a[k], b[k], t);
    return o;
  }

  // ---------- hop ----------
  // u in [0,1]: 0-.18 crouch, .18-.8 air, .8-1 land
  function hopPose(u, base) {
    const p = mix(base, base, 0);
    const air = range(u, 0.18, 0.8);
    const inAir = u > 0.18 && u < 0.8;
    const crouch = u < 0.18 ? Math.sin((u / 0.18) * Math.PI * 0.5) : u < 0.26 ? 1 - (u - 0.18) / 0.08 : 0;
    const land = u > 0.8 ? Math.sin(((u - 0.8) / 0.2) * Math.PI) : 0;
    const arc = inAir ? Math.sin(air * Math.PI) * 0.72 : 0;
    const dy = arc - 0.17 * crouch - 0.15 * land;
    p.torso = add(p.torso, [0, dy, 0]);
    p.head = add(p.head, [0, dy * 0.92, 0]);
    p.tail = p.tail.map((q) => add(q, [0, dy, 0]));
    p.pitch = inAir ? lerp(0.24, -0.18, air) : -0.06 * crouch;
    p.hPitch = base.hPitch - p.pitch * 0.75;
    const stretch = inAir ? Math.sin(Math.min(air / 0.5, 1) * Math.PI) * 0.07 : 0;
    p.squash = [1 + 0.05 * crouch + 0.06 * land - stretch * 0.5, 1 - 0.1 * crouch - 0.11 * land + stretch, 1 + 0.04 * (crouch + land)];
    p.earL = p.earR = inAir ? 0.35 * Math.sin(air * Math.PI) : 0;
    // tail lifts for balance
    const tu = smooth(range(u, 0.1, 0.35)) * (1 - smooth(range(u, 0.85, 1)));
    p.tail = mix(p.tail, tailFrom(p.torso, TAIL_UP), tu);
    // legs: tuck in the air, plant on the ground
    const hips = hipsOf(p.torso, p.pitch, p.squash[1]);
    const ground = 1 - smooth(range(u, 0.16, 0.26)) + smooth(range(u, 0.74, 0.84));
    const kf = (a, b, c) => (air < 0.5 ? mix(a, b, smooth(air * 2)) : mix(b, c, smooth(air * 2 - 1)));
    for (const k of LEGS) {
      const front = k[0] === 'F';
      const rel = front ? kf([0.12, -0.7, 0], [0.32, -0.42, 0], [0.3, -0.72, 0]) : kf([-0.42, -0.58, 0], [-0.05, -0.44, 0], [0.0, -0.68, 0]);
      const airPaw = add(hips[k], rel);
      p.paws[k] = mix(airPaw, base.paws[k], clamp01(ground));
    }
    return p;
  }

  // ---------- keyframe track helper ----------
  function track(keys, t) {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 0; i < keys.length - 1; i++) {
      const [t0, v0] = keys[i], [t1, v1] = keys[i + 1];
      if (t <= t1) return mix(v0, v1, smooth((t - t0) / (t1 - t0)));
    }
    return keys[keys.length - 1][1];
  }

  // ---------- paw play (t from 0 to 2.4) ----------
  const PLAY_LIFT = [1.2, 0.92, 0.56];
  const PLAY_TAP = [1.24, 0.36, 0.5];
  const PLAY_KEYS = [
    [0.0, REST.FL], [0.3, PLAY_LIFT], [0.42, PLAY_TAP], [0.62, PLAY_LIFT], [0.82, PLAY_TAP], [1.02, PLAY_LIFT],
    [1.2, PLAY_TAP], [1.42, [1.12, 0.98, 0.62]], [1.66, [1.3, 0.5, 0.8]], [1.86, [1.2, 0.56, 0.2]],
    [2.06, PLAY_LIFT], [2.4, REST.FL],
  ];
  const PLAY_HITS = [0.42, 0.82, 1.2, 1.76];
  function playBase() {
    const p = stand();
    p.torso = [0.12, 1.3, 0];
    p.pitch = -0.05;
    p.head = [1.02, 2.33, 0.02];
    p.hPitch = -0.3;
    p.hYaw = 0.22;
    p.earL = p.earR = -0.15;
    p.paws.FR = [0.72, 0.14, -0.32];
    p.tail = tailFrom(p.torso, TAIL_LOW);
    return p;
  }
  function playPose(t) {
    const p = playBase();
    p.paws.FL = track(PLAY_KEYS, t);
    const lift = clamp01((p.paws.FL[1] - 0.14) / 0.5);
    p.hPitch -= 0.06 * lift;
    p.hRoll = 0.08 * Math.sin(t * 5.0) * smooth(range(t, 0.2, 0.6)) * (1 - smooth(range(t, 2.0, 2.4)));
    p.torso = add(p.torso, [0, -0.04 * lift, 0]);
    // tail swish
    const sw = Math.sin(t * 6.5) * 0.25;
    p.tail[3] = add(p.tail[3], [0, 0.1, sw]);
    p.tail[2] = add(p.tail[2], [0, 0.04, sw * 0.4]);
    return p;
  }

  // ---------- lick (t from 0) ----------
  function lickBase() {
    const p = mix(stand(), sit(), 0.32);
    p.head = [0.95, 2.1, 0.15];
    p.hPitch = -0.35;
    p.hYaw = 0.9;
    p.hRoll = 0.14;
    p.paws.FR = [0.66, 0.14, -0.3];
    p.happy = 1;
    p.paws.FL = add(mouthOf(p), [-0.06, -0.2, 0.1]);
    return p;
  }
  function mouthOf(p) {
    const R = mm(mm(rotY(p.hYaw), rotZ(p.hPitch)), rotX(p.hRoll));
    return add(p.head, mv(R, [0.86, -0.6, 0]));
  }
  function lickPose(t) {
    const p = lickBase();
    const f = Math.max(0, Math.sin(t * Math.PI * 2 * 1.6));
    p.tongue = f;
    p.mouth = f * 0.6;
    p.hPitch += -0.07 * f;
    p.head = add(p.head, [0.02 * f, -0.03 * f, 0]);
    p.paws.FL = add(mouthOf(p), [-0.06, -0.2 + 0.03 * Math.sin(t * Math.PI * 2 * 1.6 + 1.2), 0.1]);
    p.earL = 0.12 * Math.sin(t * 3.0);
    return p;
  }

  // ---------- idle helpers ----------
  function blinkAt(t) {
    const period = 4.3;
    const ph = ((t % period) + period) % period;
    const cycle = Math.floor(t / period);
    let b = ph < 0.17 ? Math.sin((ph / 0.17) * Math.PI) : 0;
    if (cycle % 3 === 1 && ph > 0.3 && ph < 0.47) b = Math.max(b, Math.sin(((ph - 0.3) / 0.17) * Math.PI));
    return b;
  }
  function earTwitch(t, seed) {
    const period = 5.7 + seed;
    const ph = ((t + seed * 2.3) % period + period) % period;
    return ph < 0.28 ? Math.sin((ph / 0.28) * Math.PI) * 0.5 : 0;
  }
  function breathe(p, t) {
    const b = Math.sin(t * Math.PI * 2 / 3.1);
    p.squash = [p.squash[0], p.squash[1] * (1 + 0.016 * b), p.squash[2] * (1 + 0.01 * b)];
    p.head = add(p.head, [0, 0.012 * b, 0]);
  }

  // ---------- timeline ----------
  const START = [0.55, 0, -4.2];
  const PATH = [START, [0.38, 0, -2.8], [0.2, 0, -1.4], [0, 0, 0]];
  const YAW_TRAVEL = 1.69;
  const YAW_FINAL = 0.12;
  const HOPS = [[1.35, 1.97], [1.97, 2.59], [2.59, 3.31]];
  const T = { introEnd: 1.1, hopStart: 1.35, hopEnd: 3.31, playStart: 3.8, playEnd: 6.2, lickIn: 6.2, lickStart: 6.7, lickEnd: 8.7, sitStart: 9.2, sitEnd: 10.4 };
  const BUTTON_WORLD = [1.45, 0, 0.6];

  function intro(t) {
    const p = stand();
    p.hYaw = 0;
    p.hPitch = 0.05;
    p.tail = tailFrom(p.torso, TAIL_UP);
    // anticipation: crouch + butt wiggle
    const a = range(t, T.introEnd, T.hopStart);
    if (a > 0) {
      const c = Math.sin(a * Math.PI * 0.5);
      p.torso = add(p.torso, [0, -0.12 * c, 0]);
      p.head = add(p.head, [0, -0.08 * c, 0]);
      p.wig = 0.13 * Math.sin(t * 50) * c;
      p.pitch = -0.05 * c;
      p.squash = [1 + 0.04 * c, 1 - 0.07 * c, 1 + 0.03 * c];
    }
    return p;
  }

  // state: { look: [yaw, pitch] | null, hover, tickleT, pounceT }
  function evaluate(t, state) {
    let root = PATH[0], yaw = YAW_TRAVEL, p, glitch = 0, phase = 'intro', hits = [];

    if (t < T.hopStart) {
      p = intro(t);
      breathe(p, t);
      p.blink = blinkAt(t + 3.6);
    } else if (t < T.hopEnd) {
      phase = 'hop';
      const i = HOPS.findIndex(([a, b]) => t < b);
      const [a, b] = HOPS[i];
      const u = (t - a) / (b - a);
      const air = easeIO(range(u, 0.18, 0.8));
      root = mix(PATH[i], PATH[i + 1], air);
      yaw = i < 2 ? YAW_TRAVEL : lerp(YAW_TRAVEL, YAW_FINAL, smooth(range(u, 0.12, 0.95)));
      const base = stand();
      base.hYaw = i < 2 ? 0 : lerp(0, 0.33, smooth(u));
      base.tail = tailFrom(base.torso, TAIL_UP);
      p = hopPose(u, base);
      glitch = u > 0.78 && u < 0.95 ? 1 : 0;
    } else if (t < T.playStart) {
      phase = 'settle';
      root = PATH[3]; yaw = YAW_FINAL;
      const s = stand();
      const u = smooth(range(t, T.hopEnd, T.playStart));
      p = mix(s, playBase(), u);
      p.earL = -0.15 * u + earTwitch(t, 0.3) * 0.5;
      breathe(p, t);
    } else if (t < T.playEnd) {
      phase = 'play';
      root = PATH[3]; yaw = YAW_FINAL;
      const lt = t - T.playStart;
      p = playPose(lt);
      breathe(p, t);
      hits = PLAY_HITS.map((h) => h + T.playStart);
    } else if (t < T.lickEnd) {
      phase = 'lick';
      root = PATH[3]; yaw = YAW_FINAL;
      const w = smooth(range(t, T.lickIn, T.lickStart));
      p = mix(playPose(2.4), lickPose(Math.max(0, t - T.lickStart)), w);
      if (t < T.lickStart) { p.tongue = 0; p.mouth = 0; p.happy = w > 0.6 ? 1 : 0; }
      breathe(p, t);
    } else {
      root = PATH[3]; yaw = YAW_FINAL;
      const w = easeIO(range(t, T.lickEnd, T.sitEnd));
      const end = lickBase();
      end.happy = t < T.sitStart ? 1 : 0;
      p = mix(end, sit(), w);
      p.happy = t < T.sitStart - 0.1 ? 1 : 0;
      phase = t < T.sitEnd ? 'sit' : 'idle';
      // tail wraps a beat after the body
      p.tail = mix(tailFrom(end.torso, TAIL_LOW), TAIL_SIT, easeIO(range(t, T.lickEnd + 0.3, T.sitEnd + 0.2)));
      breathe(p, t);
      if (phase === 'idle') idleLife(p, t, state);
    }
    return finalize(p, root, yaw, { phase, glitch, hits });
  }

  function idleLife(p, t, state) {
    p.blink = blinkAt(t);
    p.earL = earTwitch(t, 0.0);
    p.earR = earTwitch(t, 1.7);
    p.tail[3] = add(p.tail[3], [0.06 * Math.sin(t * 1.3), 0.05 * Math.max(0, Math.sin(t * 0.9)), 0.05 * Math.sin(t * 1.7)]);
    if (state && state.look) {
      p.hYaw = lerp(p.hYaw, state.look[0], 1);
      p.hPitch = state.look[1];
    }
    if (state && state.tickleT != null) {
      const k = range(t, state.tickleT, state.tickleT + 1.5);
      const e = Math.sin(k * Math.PI);
      if (k < 1) {
        p.happy = k > 0.05 && k < 0.92 ? 1 : 0;
        p.hRoll = 0.2 * e;
        p.earL = -0.3 * e; p.earR = -0.3 * e;
        p.head = add(p.head, [0, -0.05 * e, 0]);
      }
    }
    if (state && state.pounceT != null) {
      const k = range(t, state.pounceT, state.pounceT + 0.75);
      if (k < 1) {
        const e = Math.sin(k * Math.PI);
        const pre = k < 0.25 ? Math.sin(k / 0.25 * Math.PI) : 0;
        const dy = 0.45 * Math.max(0, Math.sin((k - 0.2) / 0.8 * Math.PI)) - 0.08 * pre;
        p.torso = add(p.torso, [0.05 * e, dy, 0]);
        p.head = add(p.head, [0.08 * e, dy, 0]);
        p.tail = p.tail.map((q, i) => add(q, [0, dy * (1 - i * 0.2), 0]));
        p.paws.FL = add(p.paws.FL, [0.15 * e, dy + 0.12 * e, 0]);
        p.paws.FR = add(p.paws.FR, [0.15 * e, dy + 0.1 * e, 0]);
        p.squash = [p.squash[0], p.squash[1] * (1 - 0.08 * pre + 0.05 * e), p.squash[2]];
        p.earL = 0.35 * e; p.earR = 0.35 * e;
      }
    }
  }

  // ---------- resolve to world uniforms ----------
  function ik(hip, paw, hint) {
    let d = sub(paw, hip);
    let dist = len(d);
    const reach = (L1 + L2) * 0.995;
    if (dist > reach) { paw = add(hip, mul(d, reach / dist)); d = sub(paw, hip); dist = reach; }
    dist = Math.max(dist, 0.05);
    const dn = mul(d, 1 / dist);
    const a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(L1 * L1 - a * a, 0));
    const perp = norm(sub(hint, mul(dn, dot(hint, dn))));
    return { knee: add(add(hip, mul(dn, a)), mul(perp, h)), paw };
  }

  // p.pointer (optional): { target: world point, amount: 0..1 } — stick held in the near front paw
  function finalize(p, root, yaw, info, cam = CAM) {
    const Ry = rotY(yaw);
    const toW = (c) => add(root, mv(Ry, c));
    const torsoW = toW(p.torso);
    const torsoM = mm(mm(rotZ(-p.pitch), rotY(-p.wig)), rotY(-yaw));
    const headW = toW(p.head);
    const headR = mm(mm(mm(Ry, rotY(p.hYaw)), rotZ(p.hPitch)), rotX(p.hRoll));
    const headM = tr(headR);

    const hipM = mm(rotY(p.wig), rotZ(p.pitch));
    const legs = [];
    for (const k of LEGS) {
      const hl = HIP[k];
      const hip = add(p.torso, mv(hipM, [hl[0], hl[1] * p.squash[1], hl[2]]));
      const hint = k[0] === 'F' ? [-0.7, -0.3, 0] : [0.6, 0.8, 0];
      const s = ik(hip, p.paws[k], hint);
      legs.push(toW(hip), toW(s.knee), toW(s.paw));
    }
    const tail = p.tail.map(toW);

    let ptr0 = [0, -99, 0], ptr1 = [0, -99, 0], ptrAmt = 0, reach = 0;
    if (p.pointer && p.pointer.amount > 0.01) {
      ptrAmt = p.pointer.amount;
      ptr0 = add(legs[2], [0, 0.06, 0]);
      const to = sub(p.pointer.target, ptr0);
      reach = Math.min(len(to), 3.2) * ptrAmt;
      ptr1 = add(ptr0, mul(norm(to), Math.max(reach, 0.05)));
    }

    // screen anchors (design px)
    const P = (w) => project(w, cam);
    const headS = P(headW);
    const bubbleS = P(add(headW, [0.42, 1.01, 0]));
    const torsoS = P(torsoW);
    const xs = [];
    for (const q of [torsoW, headW, ...legs, ...tail]) xs.push(P(q)[0]);
    const pxPerUnit = cam.f / headS[2];
    const catX = [Math.min(...xs) - 0.25 * pxPerUnit, Math.max(...xs) + 0.25 * pxPerUnit];
    const groundS = P([torsoW[0], root[1], torsoW[2]]);

    return {
      uniforms: {
        torsoC: torsoW, torsoM, torsoS: p.squash,
        headC: headW, headM,
        legs, tail,
        face: [p.blink, p.tongue, p.earL, p.earR],
        misc: [p.happy, p.mouth, 0, 0],
        bound: [...add(torsoW, [0.2, 0.55, 0]), 3.0 + reach + (p.cap > 0.01 ? 0.4 : 0)],
        ground: root[1],
        acc: [p.cap || 0, ptrAmt, 0, 0],
        ptr0, ptr1,
      },
      anchors: { head: headS, bubble: bubbleS, torso: torsoS, catX, groundY: groundS[1], pxPerUnit, ptrTip: P(ptr1) },
      info,
      cam,
    };
  }

  return {
    evaluate, project, unproject, makeCamera, CAM, T, BUTTON_WORLD, mm, tr, add, sub, mul, len, norm, mix,
    smooth, easeIO, range, clamp01, lerp,
    stand, sit, hopPose, playPose, lickPose, lickBase, blinkAt, earTwitch, breathe, idleLife, finalize, tailFrom,
    TAIL_UP,
  };
})();
