// Little May May for the chat screen. Same SDF kitten and scanline renderer as the home page,
// drawn small: she perches on the top edge of message bubbles and hops between them.
// opts: { perches(): [{ id, el, frac }] in DOM order, clipY(): canvas y of the composer edge }
window.ChatCat = function (canvas, opts) {
  const R = window.CatRig;
  const renderer = window.CatRenderer(canvas, { pitch: 3.5, mode: 1 });
  const PXU = 25;   // px per world unit -> a ~75px kitten
  const DIST = 60;
  const TOP_MARGIN = 86; // keep the head inside the canvas
  const SIT_YAW = 0.75;

  let view = null, cam = null, crect = null;
  const now = () => performance.now() / 1000;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  function measure() {
    crect = canvas.getBoundingClientRect();
    if (!crect.width || !crect.height) return false;
    if (!view || view.W !== crect.width || view.H !== crect.height || view.dpr !== (window.devicePixelRatio || 1)) {
      view = { W: crect.width, H: crect.height, dpr: window.devicePixelRatio || 1, s: 1, ox: 0, oy: 0 };
      renderer.resize(view);
      cam = R.makeCamera({ P: [0, 4, DIST], T: [0, 0, 0], f: PXU * DIST, cx: view.W / 2, cy: view.H / 2 });
    }
    return true;
  }
  const toWorld = (pt, z = 0) => R.unproject(pt[0], pt[1], cam, z);
  const TEACH_Z = 14; // she leans toward the viewer when presenting
  const PXU_T = (PXU * DIST) / (DIST - TEACH_Z);

  function perchPt(p) {
    const r = p.el.getBoundingClientRect();
    const lo = r.left - crect.left + 30, hi = r.right - crect.left - 30;
    const x = hi > lo ? clamp(r.left - crect.left + p.frac * r.width, lo, hi) : (r.left + r.right) / 2 - crect.left;
    return [x, r.top - crect.top + 1.5];
  }
  const visible = (pt) => pt[1] > TOP_MARGIN && pt[1] < opts.clipY() - 6 && pt[0] > 24 && pt[0] < view.W - 24;
  const alive = (p) => p && p.el.isConnected;
  const faceFor = (x) => (x < view.W * 0.5 ? SIT_YAW : Math.PI - SIT_YAW);

  const S = {
    mode: 'hidden',      // hidden | hop | sit | type | teach
    perch: null,
    pt: [0, 0],          // current root, canvas px
    yaw: Math.PI / 2,
    yawTarget: Math.PI / 2,
    hops: [],
    hop: null,
    typing: null,
    landT: -9,
    typeT: -9,
    lickT: -99,
    nextIdle: now() + 12,
    tickleT: null,
    look: [0.5, 0],
    teach: null,
    started: false,
  };

  // ---------- planning ----------
  function goTo(id) {
    const list = opts.perches();
    const ti = list.findIndex((p) => p.id === id);
    if (ti < 0) return;
    if (S.mode === 'teach') { S.pendingGoTo = id; return; }
    const ci = alive(S.perch) ? list.findIndex((p) => p.id === S.perch.id) : -1;
    if (ci === ti && (S.mode === 'sit' || S.mode === 'type')) { land(); return; }
    const path = [];
    if (ci >= 0 && ci !== ti) {
      const step = ci < ti ? 1 : -1;
      const mids = [];
      for (let i = ci + step; i !== ti; i += step) if (visible(perchPt(list[i]))) mids.push(list[i]);
      const n = Math.min(3, mids.length);
      for (let k = 1; k <= n; k++) path.push(mids[Math.round((k * (mids.length + 1)) / (n + 1)) - 1]);
    }
    path.push(list[ti]);
    S.hops = path;
    if (S.mode !== 'hop') nextHop();
  }

  function nextHop() {
    const target = S.hops.shift();
    if (!target) return land();
    const from = S.pt.slice();
    const to = perchPt(target);
    const dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const dx = to[0] - from[0];
    const side = Math.min(1, Math.abs(dx) / 70);
    S.yawTarget = dx >= 0 ? R.lerp(Math.PI / 2, 0.3, side) : R.lerp(Math.PI / 2, Math.PI - 0.3, side);
    S.hop = { from, target, t0: now(), dur: 0.46 + Math.min(dist, 700) / 1500, arc: 22 + Math.min(dist, 600) * 0.16 };
    S.mode = 'hop';
  }

  function land() {
    S.hop = null;
    S.pt = perchPt(S.perch);
    S.landT = now();
    S.yawTarget = faceFor(S.pt[0]);
    if (S.typing && S.perch.id === S.typing) { S.mode = 'type'; S.typeT = now(); }
    else S.mode = 'sit';
    if (S.pendingAfterLand) { const f = S.pendingAfterLand; S.pendingAfterLand = null; f(); }
  }

  function latest() {
    const list = opts.perches();
    for (let i = list.length - 1; i >= 0; i--) if (visible(perchPt(list[i]))) return list[i];
    return list[list.length - 1] || null;
  }

  // ---------- public ----------
  function setTyping(id) {
    S.typing = id;
    if (id) goTo(id);
    else if (S.mode === 'type') { S.mode = 'sit'; S.landT = now() - 0.2; }
  }

  // Re-anchor after the thread was rebuilt (chat switch): hop from where she is to the newest message.
  function reanchor() {
    if (!measure()) return;
    if (S.mode === 'teach') return;
    S.perch = alive(S.perch) ? S.perch : null;
    const target = latest();
    if (!target) return;
    if (!S.started) {
      S.started = true;
      S.pt = [view.W * 0.62, opts.clipY() + 90];
    }
    goTo(target.id);
  }

  function teach(cardEl) {
    measure();
    S.hops = [];
    const cr = cardEl.getBoundingClientRect();
    const hideX = clamp(cr.left - crect.left - 74, 40, view.W - 40);
    S.teach = { el: cardEl, phase: 'duck', t0: now(), from: S.pt.slice(), hideX };
    S.yawTarget = hideX >= S.pt[0] ? 0.35 : Math.PI - 0.35;
    S.mode = 'teach';
    S.hop = null;
  }
  function dismissTeach() {
    if (!S.teach) return;
    if (S.teach.phase === 'duck' || S.teach.phase === 'rise' || S.teach.phase === 'point') {
      S.teach.phase = 'hide';
      S.teach.t0 = now();
    }
  }

  function hit(x, y) {
    if (!S.lastFrame) return false;
    const h = S.lastFrame.anchors.head;
    const ok = Math.hypot(x - h[0], y - h[1]) < PXU * 1.3;
    if (ok && (S.mode === 'sit' || S.mode === 'type')) S.tickleT = now();
    return ok;
  }

  // ---------- poses ----------
  function lookFor(p, root, yaw, mouse) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const head = [root[0] + c * p.head[0] - s * p.head[2], root[1] + p.head[1], root[2] + s * p.head[0] + c * p.head[2]];
    const target = mouse ? R.add(toWorld(mouse), [0, 0, 6]) : R.add(head, [0, 0.4, 10]);
    const d = R.sub(target, head);
    const hy = clamp(wrap(Math.atan2(d[2], d[0]) - yaw), -1.05, 1.05);
    const hp = clamp(Math.atan2(d[1], Math.hypot(d[0], d[2])) * 0.8, -0.45, 0.35);
    return [hy, hp];
  }

  function sitPose(t, root, mouse) {
    let p = R.mix(R.stand(), R.sit(), R.smooth((t - S.landT) / 0.45));
    R.breathe(p, t);
    const lt = t - S.lickT;
    if (lt < 3.4) {
      const w = R.smooth(lt / 0.5) * (1 - R.smooth((lt - 2.9) / 0.5));
      p = R.mix(p, R.lickPose(Math.max(0, lt - 0.5)), w);
      p.happy = w > 0.6 ? 1 : 0;
    }
    const want = lookFor(p, root, S.yaw, mouse);
    S.look = [R.lerp(S.look[0], want[0], 0.08), R.lerp(S.look[1], want[1], 0.08)];
    R.idleLife(p, t, { look: lt < 3.4 ? null : S.look, tickleT: S.tickleT, pounceT: null });
    return p;
  }

  function teachPose(t) {
    const T = S.teach;
    const clipY = opts.clipY();
    const cr = T.el.getBoundingClientRect();
    const card = [cr.left - crect.left, cr.top - crect.top, cr.right - crect.left, cr.bottom - crect.top];
    const hideY = clipY + 4.2 * PXU_T;
    const showY = clipY + 0.4 * PXU_T;
    const u = t - T.t0;
    let p, root, cap = 0, ptr = 0;

    if (T.phase === 'duck') {
      const dur = 0.55;
      const k = Math.min(1, u / dur);
      const air = R.easeIO(R.range(k, 0.18, 0.8));
      const pt = [R.lerp(T.from[0], T.hideX, air), R.lerp(T.from[1], hideY, air) - 26 * Math.sin(Math.PI * R.range(k, 0.18, 0.8))];
      root = toWorld(pt, TEACH_Z * R.smooth(k));
      const base = R.stand();
      base.tail = R.tailFrom(base.torso, R.TAIL_UP);
      p = R.hopPose(k, base);
      if (k >= 1) { T.phase = 'rise'; T.t0 = t; }
    } else {
      p = R.sit();
      R.breathe(p, t);
      let y = showY;
      if (T.phase === 'rise') {
        const k = Math.min(1, u / 0.7);
        const back = 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2); // ease-out-back
        y = R.lerp(hideY, showY, back);
        cap = R.smooth(R.range(k, 0.3, 0.85));
        ptr = R.smooth(R.range(k, 0.5, 1));
        if (k >= 1) { T.phase = 'point'; T.t0 = t; }
      } else if (T.phase === 'point') {
        cap = 1; ptr = 1;
      } else if (T.phase === 'hide') {
        const k = Math.min(1, u / 0.5);
        cap = 1 - R.smooth(k / 0.6);
        ptr = 1 - R.smooth(k / 0.5);
        y = R.lerp(showY, hideY, R.smooth(R.range(k, 0.2, 1)));
        if (k >= 1) {
          S.teach = null;
          S.mode = 'hidden';
          S.pt = [T.hideX, hideY];
          S.perch = null;
          const after = S.pendingGoTo;
          S.pendingGoTo = null;
          const target = after ? opts.perches().find((q) => q.id === after) : latest();
          if (target) goTo(target.id);
        }
      }
      root = toWorld([T.hideX, y], TEACH_Z);
      S.yawTarget = 0.62;
      const tp = T.phase === 'point' ? u : 0;
      // raise the near paw, hold the pointer toward the card's left edge, tap it
      p.paws.FL = [0.92, 1.42, 0.34];
      p.torso = R.add(p.torso, [0.05, 0.04, 0]);
      const tap = Math.pow(Math.max(0, Math.sin(tp * Math.PI * 2 * 1.8)), 2) * (tp < 1.7 || tp % 4.5 < 0.9 ? 1 : 0);
      const aim = toWorld([card[0] + 8 - 12 * (1 - tap), card[3] - 30], TEACH_Z);
      p.pointer = { target: aim, amount: ptr };
      p.cap = cap;
      const lookCard = T.phase === 'point' && (tp < 1.1 || tp % 5 > 3.9);
      p.hYaw = lookCard ? -0.25 : 0.8;
      p.hPitch = lookCard ? -0.05 : 0.06;
      p.mouth = T.phase === 'point' && tp < 1.3 ? 0.55 * Math.abs(Math.sin(tp * 9)) : 0;
      p.blink = R.blinkAt(t);
      p.earL = p.earR = T.phase === 'point' ? -0.1 + R.earTwitch(t, 0.5) : 0;
    }
    return { p, root };
  }

  // ---------- frame ----------
  function update(mouse) {
    if (!measure()) return;
    const t = now();
    let p, root;
    if (S.perch && !alive(S.perch)) S.perch = null;

    // keep a perch in view while the thread scrolls
    if ((S.mode === 'sit' || S.mode === 'type') && S.perch && !visible(perchPt(S.perch))) {
      const list = opts.perches().filter((q) => visible(perchPt(q)));
      if (list.length) {
        const cur = perchPt(S.perch);
        list.sort((a, b) => Math.abs(perchPt(a)[1] - cur[1]) - Math.abs(perchPt(b)[1] - cur[1]));
        S.pt = cur;
        goTo(list[0].id);
      }
    }
    if ((S.mode === 'sit' || S.mode === 'type') && !S.perch) { const l = latest(); if (l) goTo(l.id); }

    if (S.mode === 'teach') {
      ({ p, root } = teachPose(t));
    } else if (S.mode === 'hop' && S.hop) {
      const H = S.hop;
      const u = (t - H.t0) / H.dur;
      if (!alive(H.target)) { S.hop = null; S.mode = 'hidden'; }
      else if (u >= 1) {
        S.perch = H.target;
        S.pt = perchPt(H.target);
        if (S.hops.length) nextHop(); else land();
      }
      const to = alive(H.target) ? perchPt(H.target) : H.from;
      const k = Math.min(u, 1);
      const air = R.easeIO(R.range(k, 0.18, 0.8));
      const pt = [R.lerp(H.from[0], to[0], air), R.lerp(H.from[1], to[1], air) - H.arc * Math.sin(Math.PI * R.range(k, 0.18, 0.8))];
      root = toWorld(pt);
      const base = R.stand();
      base.tail = R.tailFrom(base.torso, R.TAIL_UP);
      base.hYaw = 0;
      p = R.hopPose(k, base);
    } else if (S.mode === 'sit' || S.mode === 'type') {
      S.pt = perchPt(S.perch);
      root = toWorld(S.pt);
      p = sitPose(t, root, mouse);
      if (S.mode === 'type') {
        const typing = R.playPose(0.3 + ((t - S.typeT) % 0.72));
        typing.blink = R.blinkAt(t);
        p = R.mix(p, typing, R.smooth((t - S.typeT) / 0.35));
      }
      if (S.mode === 'sit' && t > S.nextIdle) {
        S.nextIdle = t + 13 + Math.random() * 11;
        const others = opts.perches().filter((q) => q !== S.perch && visible(perchPt(q)));
        if (Math.random() < 0.5 || !others.length) S.lickT = t;
        else goTo(others[Math.floor(Math.random() * others.length)].id);
      }
    } else {
      renderer.render(R.finalize(R.sit(), [0, -999, 0], 0, { glitch: 0, hits: [] }, cam), t,
        { intro: 99, btn: [-1e4, -1e4, -1e4, -1e4], clip: [0, 0, 0, 0] });
      return;
    }

    S.yaw += wrap(S.yawTarget - S.yaw) * (S.mode === 'hop' || S.mode === 'teach' ? 0.22 : 0.12);
    const frame = R.finalize(p, root, S.yaw, { glitch: 0, hits: [] }, cam);
    S.lastFrame = frame;
    renderer.render(frame, t, { intro: 99, btn: [-1e4, -1e4, -1e4, -1e4], clip: [0, 0, view.W, opts.clipY()] });
  }

  return { update, goTo, setTyping, reanchor, teach, dismissTeach, hit, state: S };
};
