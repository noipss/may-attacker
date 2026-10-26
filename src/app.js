(function () {
  const Rig = window.CatRig;
  const canvas = document.getElementById('scene');
  const stages = [document.getElementById('stage'), document.getElementById('stageFront')];
  const cta = document.getElementById('cta');
  const bubble = document.getElementById('bubble');
  const bubbleText = document.getElementById('bubbleText');
  const renderer = window.CatRenderer(canvas);
  const capture = new URLSearchParams(location.search).has('capture');

  const DESIGN_W = 1440, DESIGN_H = 900;
  let view;
  function layout() {
    const W = window.innerWidth, H = window.innerHeight;
    const s = Math.min(W / DESIGN_W, H / DESIGN_H);
    const ox = (W - DESIGN_W * s) / 2, oy = (H - DESIGN_H * s) / 2;
    view = { W, H, dpr: window.devicePixelRatio || 1, s, ox, oy };
    for (const el of stages) el.style.transform = `translate(${ox}px, ${oy}px) scale(${s})`;
    renderer.resize(view);
  }
  layout();
  window.addEventListener('resize', layout);

  // ---------- speech bubble ----------
  const SCRIPT = [
    [0.95, 'Mrrp? Systems\nwarming up.'],
    [1.4, 'Hop, hop, hop…\nincoming!'],
    [3.45, 'Pat pat. Is this\nthe work button?'],
    [6.3, 'One sec, quick\ngrooming break.'],
    [9.5, 'Purr! Claws out,\nready to attack.'],
  ];
  const REPLIES = {
    hover: 'Go on, click it.\nI dare you.',
    work: "Attack mode: ON.\nLet's get to work!",
    tickle: 'Mrrrp! That\ntickles.',
  };
  const TYPE_SPEED = 0.028;
  let override = null; // { text, t, until }

  function messageAt(t) {
    if (override && t >= override.t && (override.until == null || t < override.until)) return override;
    let m = null;
    for (const [mt, text] of SCRIPT) if (t >= mt) m = { text, t: mt };
    return m;
  }

  // ---------- state ----------
  let t0 = performance.now();
  let frozen = null;
  const state = { look: null, tickleT: null, pounceT: null };
  let mouse = null, hoverBtn = false;
  let lookSm = [0.45, -0.02];
  let bubblePos = null;
  let lastAnchors = null;
  const now = () => (frozen != null ? frozen : (performance.now() - t0) / 1000);

  function toDesign(e) {
    return [(e.clientX - view.ox) / view.s, (e.clientY - view.oy) / view.s];
  }
  window.addEventListener('mousemove', (e) => { mouse = toDesign(e); });
  window.addEventListener('mouseleave', () => { mouse = null; });

  cta.addEventListener('mouseenter', () => {
    hoverBtn = true;
    const t = now();
    if (t > Rig.T.sitEnd && (!override || override.until != null)) override = { text: REPLIES.hover, t, until: null, kind: 'hover' };
  });
  cta.addEventListener('mouseleave', () => {
    hoverBtn = false;
    if (override && override.kind === 'hover') override.until = now() + 1.2;
  });
  cta.addEventListener('click', () => {
    const t = now();
    if (t < Rig.T.sitEnd) { t0 -= (Rig.T.sitEnd - t) * 1000; } // skip ahead to the ready pose
    const tt = now();
    state.pounceT = tt;
    pressUntil = tt + 0.16;
    override = { text: REPLIES.work, t: tt, until: tt + 4, kind: 'work' };
    if (!capture) setTimeout(() => window.MayChat && window.MayChat.enter(), 950);
  });
  window.addEventListener('click', (e) => {
    if (e.target === cta || !lastAnchors) return;
    const [x, y] = toDesign(e);
    const a = lastAnchors;
    const r = a.pxPerUnit;
    const onHead = Math.hypot(x - a.head[0], y - a.head[1]) < r * 1.0;
    const onBody = Math.hypot(x - a.torso[0], (y - a.torso[1]) * 1.3) < r * 1.1;
    const t = now();
    if ((onHead || onBody) && t > Rig.T.sitEnd) {
      state.tickleT = t;
      override = { text: REPLIES.tickle, t, until: t + 3, kind: 'tickle' };
    }
  });
  document.getElementById('logo').addEventListener('click', (e) => {
    e.preventDefault();
    t0 = performance.now();
    override = null;
    state.tickleT = state.pounceT = null;
    bubblePos = null;
  });

  let pressUntil = -1;

  // ---------- frame ----------
  function frame() {
    const t = now();
    const idle = t > Rig.T.sitEnd;

    // head look target
    let target = [0.45, -0.02];
    if (idle && hoverBtn) target = [0.08, -0.36];
    else if (idle && mouse && lastAnchors) {
      const dx = mouse[0] - lastAnchors.head[0], dy = mouse[1] - lastAnchors.head[1];
      target = [0.45 - Math.max(-1, Math.min(1, dx / 520)) * 0.42, Math.max(-0.32, Math.min(0.26, -dy / 700))];
    }
    const k = frozen != null ? 1 : 0.08;
    lookSm = [lookSm[0] + (target[0] - lookSm[0]) * k, lookSm[1] + (target[1] - lookSm[1]) * k];
    state.look = idle ? lookSm : null;

    const f = Rig.evaluate(t, state);
    lastAnchors = f.anchors;

    // button anchored to its spot on the floor
    const b = Rig.project(Rig.BUTTON_WORLD);
    const bx = Math.round(b[0] - 76), by = Math.round(b[1] - 38);
    const pressed = f.info.hits.some((h) => t >= h && t < h + 0.13) || t < pressUntil;
    cta.style.transform = `translate(${bx}px, ${by + (pressed ? 3 : 0)}px)`;
    cta.classList.toggle('pressed', pressed);
    cta.classList.toggle('on', t > 0.35);

    // bubble follows the head
    const m = messageAt(t);
    bubble.classList.toggle('on', !!m);
    if (m) {
      const n = Math.max(0, Math.floor((t - m.t) / TYPE_SPEED));
      const txt = m.text.slice(0, n);
      if (bubbleText.textContent !== txt) bubbleText.textContent = txt;
      const tx = f.anchors.bubble[0] - 23, ty = Math.max(84, f.anchors.bubble[1] - bubble.offsetHeight - 18);
      if (!bubblePos || frozen != null) bubblePos = [tx, ty];
      else bubblePos = [bubblePos[0] + (tx - bubblePos[0]) * 0.2, bubblePos[1] + (ty - bubblePos[1]) * 0.2];
      bubble.style.transform = `translate(${Math.round(bubblePos[0])}px, ${Math.round(bubblePos[1])}px)`;
    }

    renderer.render(f, t, { intro: t, btn: [bx, by, bx + 152, by + 40] });
  }

  const fps = { n: 0, worst: 0, last: 0 };
  window.__fps = () => fps;
  function loop() {
    if (document.body.classList.contains('in-chat')) { requestAnimationFrame(loop); return; }
    const tn = performance.now();
    if (fps.last) { fps.n++; fps.worst = Math.max(fps.worst, tn - fps.last); }
    fps.last = tn;
    frame();
    requestAnimationFrame(loop);
  }

  window.__bench = (n = 60) => {
    const gl = canvas.getContext('webgl2');
    const a = performance.now();
    for (let i = 0; i < n; i++) { frozen = 4 + i * 0.05; frame(); gl.finish(); }
    return (performance.now() - a) / n;
  };
  window.__poke = (what) => {
    if (what === 'cta') cta.click();
    if (what === 'hover') cta.dispatchEvent(new MouseEvent('mouseenter'));
    if (what === 'cat' && lastAnchors) {
      const [x, y] = lastAnchors.head;
      window.dispatchEvent(new MouseEvent('click', { clientX: x * view.s + view.ox, clientY: y * view.s + view.oy }));
    }
  };
  window.__freeze = (t) => { frozen = t; bubblePos = null; frame(); };
  if (capture) { frozen = 0; frame(); } else loop();
})();
