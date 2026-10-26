// Tiny 60fps May May that plays with a coin next to the balance, in the drawn scanline style.
// She bats a coin one way, leaps after it in an arc (legs stretched, not balled up), then mirrors.
// More balance → more coins. The scene is a deterministic function of time, so it freezes for QA.
window.BalanceCat = function (canvas, getCoins) {
  const ctx = canvas.getContext('2d');
  const FUR = '#f3f1ee';
  const INK = '#0b0b0c';
  const SHADE = 'rgba(10,10,10,0.16)';
  const SCALE = 0.92;

  const CYCLE = 2.3;
  let view = { W: 0, H: 0, dpr: 1 };
  let raf = null, running = false, frozen = null, coinsOverride = null;
  const startedAt = performance.now();

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const easeIO = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const easeOut = (x) => 1 - Math.pow(1 - x, 3);
  const hash = (n) => { const s = Math.sin(n * 127.1) * 43758.5; return s - Math.floor(s); };

  function measure() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return false;
    const dpr = window.devicePixelRatio || 1;
    if (view.W !== w || view.H !== h || view.dpr !== dpr) {
      view = { W: w, H: h, dpr };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    return true;
  }

  // ---------- scene geometry as a function of time ----------
  function scene(t) {
    const W = view.W;
    const groundY = view.H - 8;
    const aX = W * 0.30, bX = W * 0.70;
    const coinA = W * 0.37, coinB = W * 0.63;
    const i = Math.floor(t / CYCLE), p = t - i * CYCLE;
    const even = (i % 2) === 0;
    const facing = even ? 1 : -1;
    const catFrom = even ? aX : bX, catTo = even ? bX : aX;
    const coinFrom = even ? coinA : coinB, coinTo = even ? coinB : coinA;
    const r = 5.6;

    let coinX, coinHop = 0;
    if (p < 0.30) coinX = coinFrom;
    else if (p < 1.12) { const u = easeOut((p - 0.30) / 0.82); coinX = lerp(coinFrom, coinTo, u); coinHop = Math.sin(u * Math.PI) * 3.5 * (1 - u); }
    else coinX = coinTo;
    const spin = Math.abs(coinX - coinFrom) / r + i * 0.7;

    let x = catFrom, lift = 0, sx = 1, sy = 1, air = 0, paw = 0, lean = 0;
    const breathe = Math.sin(t * 3.0) * 0.012;
    if (p < 0.46) { const u = p / 0.46; paw = Math.sin(clamp((u - 0.12) / 0.5, 0, 1) * Math.PI); lean = Math.sin(u * Math.PI) * 0.10; sy = 1 - 0.05 * Math.sin(u * Math.PI); }
    else if (p < 0.95) { const u = (p - 0.46) / 0.49; lean = 0.03 * Math.sin(u * Math.PI); }
    else if (p < 1.15) { const u = (p - 0.95) / 0.20; sy = 1 - 0.16 * Math.sin(u * Math.PI * 0.5); sx = 1 + 0.10 * Math.sin(u * Math.PI * 0.5); }
    else if (p < 1.85) { const u = (p - 1.15) / 0.70; x = lerp(catFrom, catTo, easeIO(u)); lift = Math.sin(u * Math.PI) * Math.min(view.H - 46, 26); air = Math.sin(u * Math.PI); sy = 1 + 0.06 * air; }
    else if (p < 2.05) { const u = (p - 1.85) / 0.20; x = catTo; sy = lerp(0.84, 1, u); sx = lerp(1.14, 1, u); }
    else x = catTo;
    sy += breathe;

    const blink = (t % 3.6) < 0.12 ? 1 : 0;
    const ear = Math.sin(t * 2.2 + i) * 0.4;
    const tail = Math.sin(t * 2.6 + i * 1.3);
    return { groundY, facing, x, lift, sx, sy, air, paw, lean, blink, ear, tail, coinX, coinY: groundY - r - coinHop, spin, r };
  }

  // ---------- coin ----------
  function coin(cx, cy, r, spin, bright) {
    const c = Math.cos(spin), rx = Math.max(r * 0.1, r * Math.abs(c));
    ctx.save();
    ctx.translate(cx, cy);
    if (rx < r * 0.34) {
      // edge-on: a thin coin showing its thickness
      ctx.fillStyle = bright ? '#efece8' : '#ddd9d4';
      ctx.strokeStyle = INK; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.ellipse(0, 0, Math.max(1.3, rx) + 1, r, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore(); return;
    }
    ctx.beginPath(); ctx.ellipse(0, 0, rx, r, 0, 0, Math.PI * 2);
    ctx.fillStyle = bright ? '#f6f4f1' : '#e6e3df'; ctx.fill();
    ctx.lineWidth = 1.6; ctx.strokeStyle = INK; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(0, 0, rx * 0.6, r * 0.6, 0, 0, Math.PI * 2);
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(10,10,10,0.55)'; ctx.stroke();
    ctx.strokeStyle = 'rgba(10,10,10,0.7)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, -r * 0.42); ctx.lineTo(0, r * 0.42); ctx.moveTo(-rx * 0.42, 0); ctx.lineTo(rx * 0.42, 0); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(-rx * 0.28, -r * 0.3, rx * 0.26, r * 0.3, 0, Math.PI * 0.9, Math.PI * 1.7); ctx.stroke();
    ctx.restore();
  }

  // ---------- cat ----------
  function limb(hip, paw, w, sock) {
    ctx.strokeStyle = FUR; ctx.lineCap = 'round'; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(hip[0], hip[1]); ctx.lineTo(paw[0], paw[1]); ctx.stroke();
    ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.ellipse(paw[0], paw[1], sock, sock * 0.8, 0, 0, Math.PI * 2); ctx.fill();
  }

  function drawCat(s) {
    ctx.save();
    ctx.translate(s.x, s.groundY - s.lift);
    ctx.scale(s.facing * SCALE, SCALE);
    ctx.rotate(s.air * -0.06);
    ctx.scale(s.sx, s.sy);

    // tail (S-curve, dark tip)
    ctx.lineCap = 'round';
    const tw = s.tail * 2, tipX = -19 + tw * 0.5, tipY = -24 - s.air * 3;
    ctx.beginPath(); ctx.moveTo(-13, -13); ctx.quadraticCurveTo(-21, -12 + tw, tipX, tipY);
    ctx.lineWidth = 4; ctx.strokeStyle = FUR; ctx.stroke();
    ctx.lineWidth = 1.2; ctx.strokeStyle = INK; ctx.stroke();
    ctx.beginPath(); ctx.arc(tipX, tipY, 2.4, 0, Math.PI * 2); ctx.fillStyle = INK; ctx.fill();

    // back legs
    limb([-9, -9], [lerp(-9, -17, s.air), lerp(0, -4, s.air)], 3.4, 2);
    limb([-5, -9], [lerp(-4, -13, s.air), lerp(0, -1, s.air)], 3.4, 2);

    // body (elongated) + rump + chest
    const body = new Path2D();
    body.ellipse(-2, -15, 13.5, 8.2, 0, 0, Math.PI * 2);
    body.ellipse(-11, -14, 6.5, 6.5, 0, 0, Math.PI * 2);
    body.ellipse(8, -14, 6.2, 6.6, 0, 0, Math.PI * 2);
    ctx.fillStyle = FUR; ctx.fill(body);
    ctx.save(); ctx.clip(body);
    ctx.strokeStyle = SHADE; ctx.lineWidth = 1;
    for (let y = -22; y < -5; y += 2) { ctx.beginPath(); ctx.moveTo(-20, y); ctx.lineTo(16, y); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(120,116,110,0.5)'; ctx.lineWidth = 1.4;
    for (let k = 0; k < 4; k++) { const bx = -9 + k * 4; ctx.beginPath(); ctx.moveTo(bx, -22); ctx.lineTo(bx - 1.5, -17); ctx.stroke(); }
    ctx.restore();
    ctx.lineWidth = 1.3; ctx.strokeStyle = INK; ctx.stroke(body);

    // front legs (reach forward in the leap / bat)
    limb([8, -8], [lerp(8, 17, s.air), lerp(0, -1, s.air)], 3.4, 2);
    const fp2 = s.paw > 0.03 ? [lerp(13, 22, s.paw), lerp(0, 1, s.paw)] : [lerp(13, 20, s.air), lerp(0, 1, s.air)];
    limb([13, -8], fp2, 3.4, 2);

    // head + muzzle
    const head = new Path2D();
    head.ellipse(14, -20, 6.4, 6.2, 0, 0, Math.PI * 2);
    head.ellipse(19, -18, 3.4, 2.9, 0, 0, Math.PI * 2);
    ctx.fillStyle = FUR; ctx.fill(head);
    ctx.save(); ctx.clip(head);
    ctx.strokeStyle = SHADE; ctx.lineWidth = 1;
    for (let y = -24; y < -14; y += 2) { ctx.beginPath(); ctx.moveTo(8, y); ctx.lineTo(23, y); ctx.stroke(); }
    ctx.restore();

    // ears (inner dark)
    const tri = (p0, p1, p2, dark) => { ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.closePath(); ctx.fillStyle = dark ? INK : FUR; ctx.fill(); if (!dark) { ctx.lineWidth = 1.1; ctx.strokeStyle = INK; ctx.stroke(); } };
    tri([9, -23], [8.5, -31 - s.ear * 2], [13.5, -25], true);
    tri([13.5, -24], [17, -32 + s.ear * 2], [19, -23], false);
    tri([15, -25], [16.5, -29.5 + s.ear * 2], [17.6, -24.5], true);
    ctx.lineWidth = 1.3; ctx.strokeStyle = INK; ctx.stroke(head);

    // face: mask, eye, nose, mouth, whiskers
    ctx.fillStyle = 'rgba(11,11,12,0.14)';
    ctx.beginPath(); ctx.ellipse(16.5, -19.5, 4.2, 3.8, 0, 0, Math.PI * 2); ctx.fill();
    if (s.blink) { ctx.strokeStyle = INK; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(14.4, -20.4); ctx.lineTo(17, -20.4); ctx.stroke(); }
    else { ctx.fillStyle = INK; ctx.beginPath(); ctx.ellipse(15.6, -20.4, 1.5, 2.1, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fff'; ctx.fillRect(15.9, -21.4, 0.9, 0.9); }
    ctx.fillStyle = INK; ctx.beginPath(); ctx.moveTo(20.6, -18.6); ctx.lineTo(22.2, -18.6); ctx.lineTo(21.4, -17.2); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = INK; ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.moveTo(21.4, -17.2); ctx.quadraticCurveTo(20.2, -16.2, 19.2, -16.8); ctx.moveTo(21.4, -17.2); ctx.quadraticCurveTo(22.4, -16.2, 23.2, -16.8); ctx.stroke();
    ctx.strokeStyle = 'rgba(11,11,12,0.5)'; ctx.lineWidth = 0.8;
    for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.moveTo(20.5, -18 + k * 1.1); ctx.lineTo(26.5, -18.5 + k * 2.2); ctx.stroke(); }

    ctx.restore();
  }

  function stashCoins(t, n, s) {
    const W = view.W, g = s.groundY, r = 5;
    for (let k = 0; k < n; k++) {
      const seed = k + 1;
      const x = lerp(W * 0.1, W * 0.9, hash(seed * 1.7));
      const y = g - r + 1 + Math.sin(t * 2 + seed) * 0.5;
      coin(x, y, r, seed * 2.1 + t * 0.15 * (hash(seed) - 0.5), false);
    }
  }

  function drawOnce() {
    if (!measure()) return;
    const t = frozen != null ? frozen : (performance.now() - startedAt) / 1000;
    const s = scene(t);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, view.W, view.H);
    ctx.strokeStyle = 'rgba(11,11,12,0.26)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(6, s.groundY + 4.5); ctx.lineTo(view.W - 6, s.groundY + 4.5); ctx.stroke();

    const want = coinsOverride != null ? coinsOverride : (getCoins ? getCoins() : 1);
    const target = clamp(Math.round(want), 0, 16);
    stashCoins(t, Math.max(0, target - 1), s);
    if (target >= 1) coin(s.coinX, s.coinY, s.r, s.spin, true);
    drawCat(s);
  }

  function frame() { if (!running) return; drawOnce(); raf = requestAnimationFrame(frame); }
  function start() { if (running) return; running = true; raf = requestAnimationFrame(frame); }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = null; }

  window.__balCat = {
    freeze: (t) => { frozen = t; drawOnce(); },
    unfreeze: () => { frozen = null; },
    setCoins: (n) => { coinsOverride = n; },
    cycle: CYCLE,
  };
  return { start, stop };
};
