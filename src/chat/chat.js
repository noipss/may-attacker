// Chat screen controller: chat list, thread, streaming (text + thinking), terminal cards with
// approvals, composer (incl. !commands), model/folder chips, settings, AI notifications.
window.MayChat = (function () {
  const may = window.may;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const view = $('chatView');
  const list = $('chatList');
  const thread = $('thread');
  const inner = $('threadInner');
  const input = $('input');
  const sendBtn = $('sendBtn');
  const composer = $('composer');
  const card = $('notify');
  const menu = $('provMenu');

  const S = { chats: [], chat: null, busy: false, settings: null, shown: false, mouse: null, queue: [], note: null, skillItems: [], skillIdx: 0, skillEditing: null, balTimer: null };

  const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const when = (ts) => {
    const d = new Date(ts);
    return d.toDateString() === new Date().toDateString() ? hhmm(ts) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return ((h >>> 0) % 1000) / 1000; };
  const tilde = (p) => (p && S.settings && p.startsWith(S.settings.home) ? `~${p.slice(S.settings.home.length)}` : p || '~');
  const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const secs = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`);
  const plain = (t) => t.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  const PROVIDER_NAME = { deepseek: 'DeepSeek', openrouter: 'OpenRouter', claude: 'Claude' };
  const MODE_TEXT = { ready: 'ready', demo: 'no key · demo', invalid: 'key rejected', offline: 'offline', checking: 'checking…' };

  // ---------- decor ----------
  $('brandMark').innerHTML = window.PixelFont.render(['MAY', 'ATTACKER'], 1, 37);
  (function headerField() {
    const rows = [];
    for (let i = 0; i < 10; i++) {
      if (Math.random() < 0.12) continue;
      const x0 = 8 + Math.random() * 55 + (i < 2 || i > 7 ? 18 : 0);
      const gray = Math.random() < 0.26;
      rows.push(`<line x1="${x0}" x2="100" y1="${i * 6 + 2}" y2="${i * 6 + 2}" stroke="${gray ? '#8e8d8b' : '#171717'}" stroke-width="2" vector-effect="non-scaling-stroke"/>`);
      if (Math.random() < 0.35) {
        const d = x0 - 6 - Math.random() * 12;
        rows.push(`<line x1="${d}" x2="${d + 2 + Math.random() * 4}" y1="${i * 6 + 2}" y2="${i * 6 + 2}" stroke="#171717" stroke-width="2" vector-effect="non-scaling-stroke"/>`);
      }
    }
    $('phField').innerHTML = `<svg viewBox="0 0 100 58" preserveAspectRatio="none">${rows.join('')}</svg>`;
  })();

  // ---------- kitten ----------
  // Where on a bubble's top edge she sits: the first spot (in a per-message preference order)
  // where a ~70px kitten doesn't cover the message above or this message's label.
  function perchFrac(n) {
    const side = n.dataset.side;
    if (side === 'hero') return 0.5;
    const msg = n.closest('.msg');
    const prev = msg && msg.previousElementSibling;
    const key = `${Math.round(n.offsetWidth)}|${prev ? prev.dataset.mid : ''}|${prev ? prev.offsetWidth : 0}`;
    if (n._perch && n._perch.key === key) return n._perch.frac;
    const r = n.getBoundingClientRect();
    const avoid = [];
    if (prev) avoid.push((prev.querySelector('.box, .term-box') || prev).getBoundingClientRect());
    const meta = msg && msg.querySelector('.msg-meta');
    if (meta) {
      const w = meta.textContent.length * 7.9 + 8;
      avoid.push(side === 'user' ? { left: r.right - w, right: r.right, top: r.top - 26, bottom: r.top } : { left: r.left, right: r.left + w, top: r.top - 26, bottom: r.top });
    }
    const pref = side === 'user' ? [0.14, 0.3, 0.46, 0.62, 0.78] : [0.8, 0.66, 0.92, 0.52, 0.38, 0.24];
    const shift = Math.floor(hash(n.dataset.perch) * 2);
    const order = pref.slice(shift).concat(pref.slice(0, shift));
    let best = order[0], bestA = Infinity;
    for (const f of order) {
      const x = Math.min(Math.max(r.left + f * r.width, r.left + 30), r.right - 30);
      const c = { left: x - 36, right: x + 36, top: r.top - 84, bottom: r.top };
      let a = 0;
      for (const q of avoid) a += Math.max(0, Math.min(c.right, q.right) - Math.max(c.left, q.left)) * Math.max(0, Math.min(c.bottom, q.bottom) - Math.max(c.top, q.top));
      if (a < bestA - 1) { best = f; bestA = a; }
      if (a === 0) break;
    }
    n._perch = { key, frac: best };
    return best;
  }
  const cat = window.ChatCat($('chatScene'), {
    perches: () => [...inner.querySelectorAll('[data-perch]')].map((n) => ({ id: n.dataset.perch, el: n, frac: perchFrac(n) })),
    clipY: () => composer.getBoundingClientRect().top - $('chatScene').getBoundingClientRect().top,
  });
  // coins by balance: more credit left -> more coins; she always has one to bat
  function coinTarget() {
    const or = S.settings && S.settings.status && S.settings.status.openrouter;
    if (!or || or.mode !== 'ready') return 1;
    const left = or.balance && /\$([0-9.]+)\s*left/.exec(or.balance);
    if (left) return clamp(1 + Math.round(parseFloat(left[1])), 1, 16);
    return 3; // ready but no hard limit (free tier) — a small modest pile
  }
  const balCat = window.BalanceCat($('balCat'), coinTarget);
  let typingTimer = null;
  function catFor(m) {
    if (m.role === 'user') cat.goTo(m.id);
    else if (m.role === 'assistant' && m.streaming) {
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { if (m.streaming) cat.setTyping(m.id); }, 450);
    } else if (m.role === 'tool') {
      if (m.status === 'approval') { cat.setTyping(null); cat.goTo(m.id); }
      else if (m.status === 'running') cat.setTyping(m.id);
      else if (m.by === 'user' && m.status !== 'pending') cat.setTyping(null);
    }
  }

  // ---------- status, header, model menu ----------
  const provState = (p) => (S.settings ? S.settings.status[p].mode : 'checking');
  const provModel = (p) => (!S.settings ? '' : p === 'deepseek' ? S.settings.deepseek.model : p === 'openrouter' ? S.settings.openrouter.model : S.settings.status.claude.model);

  function renderStatus() {
    const p = S.chat ? S.chat.provider : S.settings && S.settings.provider;
    if (!p || !S.settings) return;
    const st = S.settings.status[p];
    $('status').className = `status ${st.mode === 'ready' ? 'claude' : st.mode}`;
    const extra = p === 'deepseek' && st.balance ? ` · ${st.balance}` : '';
    $('statusText').textContent = `${PROVIDER_NAME[p]} · ${MODE_TEXT[st.mode] || st.mode}${extra}`;
  }
  let balRefreshing = false;
  function renderBalance() {
    const amt = $('balAmount');
    if (!amt) return;
    const or = S.settings && S.settings.status && S.settings.status.openrouter;
    const bl = $('balance');
    if (!or) { amt.textContent = '—'; return; }
    if (or.mode === 'demo') { amt.textContent = 'no key'; bl.classList.remove('low'); }
    else if (or.mode === 'invalid') { amt.textContent = 'key rejected'; }
    else if (or.mode === 'offline') { amt.textContent = 'offline'; }
    else if (or.balance) { amt.textContent = or.balance; }
    else { amt.textContent = 'ready'; }
    bl.classList.toggle('refreshing', balRefreshing);
    // flag a low balance (< $1 left) so it stands out before top-up
    const m = or.balance && /\$([0-9.]+) left/.exec(or.balance);
    bl.classList.toggle('low', !!(m && parseFloat(m[1]) < 1));
  }
  async function refreshBalance() {
    if (balRefreshing) return;
    balRefreshing = true; renderBalance();
    try { applySettings(await may.refreshBalance()); }
    finally { balRefreshing = false; renderBalance(); }
  }

  function renderHeader() {
    const c = S.chat;
    $('chatTitle').textContent = c ? c.title : 'New chat';
    if (!c) return;
    const chip = $('provChip');
    chip.classList.toggle('ready', provState(c.provider) === 'ready');
    $('provLabel').textContent = `${PROVIDER_NAME[c.provider]} · ${provModel(c.provider)}`;
    chip.disabled = S.busy;
    $('cwdLabel').textContent = tilde(c.cwd);
    $('cwdChip').title = `Working folder: ${c.cwd}\nClick to change`;
    $('autoChip').hidden = !c.autoApprove;
    renderStatus();
  }

  // Single provider (OpenRouter): the model chip just opens Settings.
  $('provChip').addEventListener('click', (e) => { e.stopPropagation(); if (!S.busy) openSettings(); });
  $('cwdChip').addEventListener('click', async () => {
    if (!S.chat) return;
    const c = await may.chooseCwd(S.chat.id);
    if (c) { S.chat.cwd = c.cwd; renderHeader(); }
  });
  $('autoChip').addEventListener('click', async () => {
    if (!S.chat) return;
    await may.revokeAuto(S.chat.id);
    S.chat.autoApprove = false;
    renderHeader();
  });

  // ---------- chat list ----------
  async function refreshList() {
    S.chats = await may.listChats();
    list.textContent = '';
    if (!S.chats.length) list.append(el('div', 'list-empty', 'No chats yet.'));
    for (const c of S.chats) {
      const b = el('button', 'chat-item');
      b.type = 'button';
      if (S.chat && c.id === S.chat.id) b.classList.add('active');
      if (c.unread && !(S.chat && c.id === S.chat.id)) b.classList.add('unread');
      b.append(el('span', 'ci-title', c.title), el('span', 'ci-time', when(c.updatedAt)), el('span', 'ci-snippet', c.snippet || 'Empty chat'));
      const del = el('span', 'ci-del', '×');
      del.title = 'Delete chat';
      del.addEventListener('click', (e) => { e.stopPropagation(); removeChat(c); });
      b.append(del);
      b.addEventListener('click', () => openChat(c.id));
      list.append(b);
    }
  }

  async function openChat(id) {
    const c = await may.getChat(id);
    if (!c) return;
    S.chat = c;
    S.busy = c.busy;
    await may.openChat(id);
    renderThread();
    renderHeader();
    thread.scrollTop = thread.scrollHeight;
    syncComposer();
    refreshList();
    requestAnimationFrame(() => cat.reanchor());
    if (S.busy) {
      const live = [...c.messages].reverse().find((m) => m.streaming || (m.role === 'tool' && ['running', 'approval'].includes(m.status)));
      if (live) catFor(live);
    }
  }

  async function newChat() {
    const empty = S.chats.find((c) => c.title === 'New chat' && !c.snippet);
    if (empty) return openChat(empty.id);
    const c = await may.createChat();
    await openChat(c.id);
    input.focus();
  }

  async function removeChat(c) {
    if (!window.confirm(`Delete “${c.title}”? This can't be undone.`)) return;
    await may.deleteChat(c.id);
    if (S.chat && S.chat.id === c.id) {
      S.chat = null;
      S.chats = await may.listChats();
      if (S.chats.length) await openChat(S.chats[0].id);
      else await newChat();
    } else refreshList();
  }

  // ---------- messages ----------
  const findMsg = (id) => S.chat && S.chat.messages.find((x) => x.id === id);
  const domMsg = (id) => inner.querySelector(`.msg[data-mid="${id}"]`);

  function msgEl(m) {
    if (m.role === 'notice') {
      const n = el('div', 'msg notice');
      n.dataset.mid = m.id;
      n.append(el('span', null, `🎓 ${m.kind === 'reminder' ? 'Reminder' : 'Note'} · ${m.text}`));
      return n;
    }
    if (m.role === 'tool') return termEl(m);
    const ai = m.role === 'assistant';
    const n = el('div', `msg ${ai ? 'ai' : 'user'}`);
    n.dataset.mid = m.id;
    n.append(el('div', 'msg-meta'));
    const box = el('div', ai ? 'box md' : 'box');
    box.dataset.perch = m.id;
    box.dataset.side = ai ? 'ai' : 'user';
    n.append(box);
    fillMsg(n, m);
    return n;
  }

  function metaText(m) {
    if (m.role !== 'assistant') return `You · ${hhmm(m.ts)}`;
    const model = m.provider ? `${PROVIDER_NAME[m.provider] || ''} ${String(m.model || '').replace(/^claude-|^deepseek-/, '')}`.trim() : '';
    return `May May${model ? ` · ${model}` : ''} · ${hhmm(m.ts)}`;
  }
  function usageText(u) {
    if (!u || !(u.input + u.output)) return '';
    const cache = u.input && u.cached ? ` · ${Math.round((u.cached / u.input) * 100)}% cached` : '';
    return ` · ${fmtK(u.input)} in · ${fmtK(u.output)} out${cache}`;
  }

  function fillMsg(n, m) {
    if (m.role === 'tool') return fillTerm(n, m);
    const meta = n.querySelector('.msg-meta');
    meta.textContent = metaText(m);
    if (m.usage) meta.append(el('span', 'usage', usageText(m.usage)));
    const box = n.querySelector('.box');
    if (m.role !== 'assistant') { box.textContent = m.text; return; }

    let think = box.querySelector(':scope > .think');
    if (m.reasoning) {
      if (!think) {
        think = el('details', 'think');
        think.append(el('summary'), el('div', 'think-body'));
        think._auto = true;
        think.open = !!m.streaming && !m.text;
        if (!think.open) think._auto = false; // no toggle event fires for a closed <details>
        think.addEventListener('toggle', () => { if (!think._auto) m._thinkToggled = true; think._auto = false; });
        box.prepend(think);
      }
      const live = !!m.streaming && !m.text;
      think.classList.toggle('live', live);
      if (!live && think.open && !m._thinkToggled && !m._thinkClosed) { think._auto = true; think.open = false; m._thinkClosed = true; }
      think.querySelector('summary').textContent = live ? 'Thinking' : `Thought${m.usage && m.usage.reasoning ? ` · ${fmtK(m.usage.reasoning)} tokens` : ''}`;
      const body = think.querySelector('.think-body');
      if (body.textContent.length !== m.reasoning.length) {
        body.textContent = m.reasoning;
        if (live) body.scrollTop = body.scrollHeight;
      }
    } else if (think) think.remove();

    let md = box.querySelector(':scope > .md-body');
    if (!md) { md = el('div', 'md-body'); box.append(md); }
    md.innerHTML = window.renderMarkdown(m.text || '');
    md.hidden = !m.text && !!m.reasoning && !m.streaming;
    if (m.streaming && (m.text || !m.reasoning)) {
      let last = md.lastElementChild || md;
      if (/^(UL|OL)$/.test(last.tagName)) last = last.lastElementChild || last;
      if (last.tagName === 'PRE') last = md;
      last.append(el('span', 'caret'));
    }
    box.classList.toggle('pending', !!m.streaming && !m.text && !m.reasoning);
    let err = n.querySelector('.msg-error');
    if (m.error && !err) { err = el('div', 'msg-error'); n.append(err); }
    if (err) err.textContent = m.error ? `! ${m.error}` : '';
  }

  // ---------- tool cards (terminal + file / system tools) ----------
  const TOOL_GLYPH = { terminal: '$', run_command: '$', read_file: '👁', write_file: '✎', edit_file: '✎', open_path: '↗', download_file: '⤓' };
  const TOOL_META = { terminal: 'Terminal', run_command: 'Terminal', read_file: 'Read file', write_file: 'Write file', edit_file: 'Edit file', open_path: 'Open', download_file: 'Download' };
  const TOOL_ASK = { terminal: 'Run this command?', run_command: 'Run this command?', read_file: 'Read this file?', write_file: 'Write this file?', edit_file: 'Apply this edit?', open_path: 'Open this?', download_file: 'Download this?' };
  const isCmd = (m) => (m.tool || 'terminal') === 'terminal' || m.tool === 'run_command';

  function termEl(m) {
    const n = el('div', `msg term${m.by === 'user' ? ' user' : ''}`);
    n.dataset.mid = m.id;
    n.append(el('div', 'msg-meta'));
    const box = el('div', 'term-box');
    box.dataset.perch = m.id;
    box.dataset.side = m.by === 'user' ? 'user' : 'ai';
    const cmd = el('div', 'term-cmd');
    cmd.append(el('span', 'ps', TOOL_GLYPH[m.tool] || '$'), el('code', null, m.command));
    box.append(cmd, el('pre', 'term-out'), el('div', 'term-foot'));
    n.append(box);
    fillTerm(n, m);
    return n;
  }
  const btn = (cls, text, fn) => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; };

  function fillTerm(n, m) {
    n.querySelector('.msg-meta').textContent = `${TOOL_META[m.tool] || 'Terminal'} · ${tilde(m.cwd)} · ${m.by === 'user' ? 'you' : 'May May'}`;
    const box = n.querySelector('.term-box');
    box.classList.toggle('approval', m.status === 'approval');
    const pre = n.querySelector('.term-out');
    if (pre.textContent.length !== (m.output || '').length) { pre.textContent = m.output || ''; pre.scrollTop = pre.scrollHeight; }
    let warn = box.querySelector('.term-warn');
    const warnText = isCmd(m)
      ? '⚠ This looks risky (deletes, force-pushes, sudo…). Read it carefully before running.'
      : '⚠ This writes into a system location. Check the path carefully before allowing.';
    if (m.status === 'approval' && m.danger && !warn) { warn = el('div', 'term-warn', warnText); box.insertBefore(warn, box.querySelector('.term-foot')); }
    if (warn && m.status !== 'approval') warn.remove();

    const foot = n.querySelector('.term-foot');
    foot.textContent = '';
    foot.removeAttribute('data-running');
    const tag = (t, bad) => el('span', `tag${bad ? ' bad' : ''}`, t);
    switch (m.status) {
      case 'approval':
        foot.append(el('span', 'grow', TOOL_ASK[m.tool] || 'Allow this?'), el('span', 'kbd-hint', '⌘↵'),
          btn('btn-run', isCmd(m) ? 'Run' : 'Allow', () => may.decide(m.id, 'run')),
          btn('btn-dark', 'Always in this chat', () => { may.decide(m.id, 'always'); S.chat.autoApprove = true; renderHeader(); }),
          btn('btn-dark', 'Decline', () => may.decide(m.id, 'deny')));
        break;
      case 'pending':
        foot.append(el('span', 'grow live', 'starting'));
        break;
      case 'running':
        foot.dataset.running = m.startedAt || Date.now();
        foot.append(el('span', 'grow live', isCmd(m) ? 'running' : 'working'), isCmd(m) ? btn('btn-dark', 'Stop ■', () => may.stopTool(m.id)) : el('span'));
        break;
      default: {
        const bad = m.status !== 'done' || (isCmd(m) && m.exitCode !== 0);
        const label = m.status === 'done'
          ? (isCmd(m) ? `exit ${m.exitCode}` : 'done')
          : { denied: 'declined', stopped: 'stopped', timeout: 'timed out', error: 'failed' }[m.status] || m.status;
        foot.append(tag(label, bad));
        const bits = [];
        if (m.durationMs != null) bits.push(secs(m.durationMs));
        if (m.cwdAfter && m.cwdAfter !== m.cwd) bits.push(`→ ${tilde(m.cwdAfter)}`);
        foot.append(el('span', 'grow', bits.join(' · ')));
        if (m.auto) foot.append(tag('auto-approved'));
      }
    }
    tickRunning();
  }
  function tickRunning() {
    for (const f of inner.querySelectorAll('.term-foot[data-running] .grow')) {
      f.textContent = `running · ${secs(Date.now() - Number(f.parentElement.dataset.running))}`;
    }
  }
  setInterval(() => { if (S.shown) tickRunning(); }, 250);

  function appendOutput(id, chunk) {
    const m = findMsg(id);
    if (m) m.output = (m.output + chunk).slice(-60000);
    const n = domMsg(id);
    if (!n) return;
    const pre = n.querySelector('.term-out');
    const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
    pre.append(document.createTextNode(chunk));
    if (pre.textContent.length > 80000) pre.textContent = pre.textContent.slice(-60000);
    if (stick) pre.scrollTop = pre.scrollHeight;
    const stickT = nearBottom();
    if (stickT) thread.scrollTop = thread.scrollHeight;
  }

  function emptyState() {
    const e = el('div', 'empty');
    const t = el('div', 'empty-title');
    t.innerHTML = window.PixelFont.render(['MAY MAY'], 2, 70);
    t.dataset.perch = 'hero';
    t.dataset.side = 'hero';
    e.append(t, el('p', null, 'What are we attacking today?'));
    const chips = el('div', 'chips');
    for (const q of ['Plan my week in 4 steps', 'List the files in this folder', 'Remind me in 10 seconds to stretch']) {
      const b = el('button', 'chip', q);
      b.type = 'button';
      b.addEventListener('click', () => send(q));
      chips.append(b);
    }
    e.append(chips);
    return e;
  }

  function renderThread() {
    inner.textContent = '';
    if (!S.chat || !S.chat.messages.length) { inner.append(emptyState()); return; }
    for (const m of S.chat.messages) inner.append(msgEl(m));
  }

  const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;
  function append(m) {
    if (inner.querySelector('.empty')) inner.textContent = '';
    const stick = nearBottom() || m.role === 'user' || (m.role === 'tool' && m.by === 'user');
    inner.append(msgEl(m));
    if (stick) thread.scrollTop = thread.scrollHeight;
  }
  let pendingPaint = new Set();
  function repaint(m) {
    pendingPaint.add(m);
    if (pendingPaint.size > 1) return;
    requestAnimationFrame(() => {
      const stick = nearBottom();
      for (const x of pendingPaint) {
        const n = domMsg(x.id);
        if (n) fillMsg(n, x);
      }
      pendingPaint = new Set();
      if (stick) thread.scrollTop = thread.scrollHeight;
    });
  }

  // ---------- composer ----------
  function syncComposer() {
    sendBtn.innerHTML = S.busy ? 'Stop <span>■</span>' : input.value.trim().startsWith('!') ? 'Run <span>↵</span>' : 'Send <span>↵</span>';
    sendBtn.disabled = !S.busy && !input.value.trim();
    composer.classList.toggle('cmd', input.value.trimStart().startsWith('!'));
    $('provChip').disabled = S.busy;
  }
  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }
  input.addEventListener('input', () => { autosize(); syncComposer(); updateSkillPop(); });
  input.addEventListener('keydown', (e) => {
    if (!skillPop.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSkill(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveSkill(-1); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSkillPop(); return; }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        const pick = S.skillItems[S.skillIdx];
        if (pick) { e.preventDefault(); pickSkill(pick); return; }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.metaKey) { e.preventDefault(); composer.requestSubmit(); }
  });
  input.addEventListener('blur', () => setTimeout(closeSkillPop, 120));
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (S.busy) { may.stop(S.chat.id); return; }
    closeSkillPop();
    // "/name …" expands to the skill (exact slug, or a unique prefix) before sending
    const m = /^\/([\w-]+)(?:\s|$)/.exec(input.value.trim());
    if (m) {
      const q = m[1].toLowerCase();
      const hits = filterSkills(q);
      const exact = allSkills().find((sk) => slug(sk.name) === q);
      const pick = exact || (hits.length === 1 ? hits[0] : null);
      if (pick) { pickSkill(pick); return; }
    }
    send(input.value);
  });

  // ---------- skills (/name) ----------
  const skillPop = $('skillPop');
  const slug = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const allSkills = () => (S.settings && Array.isArray(S.settings.skills) ? S.settings.skills : []);
  function filterSkills(q) {
    const list = allSkills();
    if (!q) return list;
    const pre = [], sub = [];
    for (const sk of list) { const sl = slug(sk.name); if (sl.startsWith(q)) pre.push(sk); else if (sl.includes(q) || sk.name.toLowerCase().includes(q)) sub.push(sk); }
    return pre.concat(sub);
  }
  function closeSkillPop() { skillPop.hidden = true; S.skillItems = []; }
  function moveSkill(d) {
    if (!S.skillItems.length) return;
    S.skillIdx = (S.skillIdx + d + S.skillItems.length) % S.skillItems.length;
    renderSkillPop();
  }
  function renderSkillPop() {
    skillPop.textContent = '';
    if (!S.skillItems.length) { skillPop.append(el('div', 'sp-empty', allSkills().length ? 'No matching skill.' : 'No skills yet — add one in Settings.')); return; }
    S.skillItems.forEach((sk, i) => {
      const b = el('button');
      b.type = 'button';
      if (i === S.skillIdx) b.classList.add('sel');
      const nm = el('div', 'sp-name');
      nm.append(el('code', null, `/${slug(sk.name)}`), el('span', null, sk.name));
      if (sk.provider) nm.append(el('span', 'm', PROVIDER_NAME[sk.provider] || sk.provider));
      b.append(nm, el('div', 'sp-prompt', sk.prompt));
      b.addEventListener('mousedown', (e) => { e.preventDefault(); pickSkill(sk); });
      b.addEventListener('mouseenter', () => { S.skillIdx = i; for (const c of skillPop.children) c.classList.remove('sel'); b.classList.add('sel'); });
      skillPop.append(b);
    });
  }
  function updateSkillPop() {
    const v = input.value;
    const m = /^\/([\w-]*)$/.exec(v.trim());
    if (!m || v.includes('\n')) return closeSkillPop();
    S.skillItems = filterSkills(m[1].toLowerCase());
    S.skillIdx = 0;
    skillPop.hidden = false;
    renderSkillPop();
  }
  async function pickSkill(sk) {
    closeSkillPop();
    const rest = input.value.replace(/^\/[\w-]*\s*/, '').trim();
    if (S.chat && sk.provider && sk.provider !== S.chat.provider && !S.busy) {
      const c = await may.setProvider(S.chat.id, sk.provider);
      if (c) { S.chat.provider = c.provider; renderHeader(); }
    }
    const text = rest ? `${sk.prompt}\n\n${rest}` : sk.prompt;
    input.value = '';
    syncComposer();
    send(text);
  }
  $('skillsBtn').addEventListener('click', () => {
    if (!skillPop.hidden) { closeSkillPop(); return; }
    input.focus();
    S.skillItems = allSkills();
    S.skillIdx = 0;
    skillPop.hidden = false;
    renderSkillPop();
  });

  async function send(text) {
    text = String(text || '').trim();
    if (!text || S.busy) return;
    if (!S.chat) await newChat();
    const res = await may.send(S.chat.id, text);
    if (!res) return;
    input.value = '';
    autosize();
    S.busy = true;
    S.chat.title = res.title;
    renderHeader();
    syncComposer();
    refreshList();
  }

  // ---------- events from the main process ----------
  may.onChatEvent((ev) => {
    const mine = S.chat && ev.chatId === S.chat.id;
    switch (ev.type) {
      case 'message':
        if (mine) { S.chat.messages.push(ev.message); append(ev.message); catFor(ev.message); }
        break;
      case 'update': {
        if (mine) {
          const m = findMsg(ev.message.id);
          if (m) { Object.assign(m, ev.message); repaint(m); catFor(m); }
          if (ev.cwd) { S.chat.cwd = ev.cwd; renderHeader(); }
        } else if (ev.message.status === 'approval') {
          const em = ev.message;
          notify({ kind: 'approval', chatId: ev.chatId, text: isCmd(em) ? `$ ${em.command}` : em.command });
        }
        break;
      }
      case 'remove':
        if (mine) {
          S.chat.messages = S.chat.messages.filter((x) => x.id !== ev.messageId);
          const n = domMsg(ev.messageId);
          if (n) n.remove();
        }
        break;
      case 'delta': {
        const m = mine && findMsg(ev.messageId);
        if (m) {
          if (ev.kind === 'reasoning') m.reasoning = (m.reasoning || '') + ev.delta;
          else m.text += ev.delta;
          repaint(m);
        }
        break;
      }
      case 'output':
        if (mine) appendOutput(ev.messageId, ev.chunk);
        break;
      case 'done':
        if (mine) {
          S.busy = false;
          S.chat.title = ev.title;
          renderHeader();
          syncComposer();
          cat.setTyping(null);
        }
        refreshList();
        refreshBalance();
        if (!ev.visible && !ev.error && ev.kind !== 'command' && ev.text) {
          const flat = plain(ev.text);
          notify({ kind: 'reply', chatId: ev.chatId, text: `“${ev.title}” — ${flat.slice(0, 90)}${flat.length > 90 ? '…' : ''}` });
        }
        break;
      default:
    }
  });

  // ---------- AI notifications: May May pops up in her cap with a pointer ----------
  may.onNotify((n) => {
    if (S.chat && n.chatId === S.chat.id && n.message) { S.chat.messages.push(n.message); append(n.message); }
    notify(n);
  });

  function notify(n) {
    if (!S.shown || S.note) { S.queue.push(n); return; }
    S.note = n;
    $('ntTag').textContent = { reminder: 'Reminder', reply: 'New reply', approval: 'Needs your OK' }[n.kind] || 'May May';
    $('ntTime').textContent = hhmm(Date.now());
    $('ntText').textContent = n.text;
    $('ntOpen').hidden = !(n.chatId && (!S.chat || n.chatId !== S.chat.id));
    card.style.bottom = `${composer.offsetHeight + 14}px`;
    card.classList.remove('out');
    card.hidden = false;
    cat.teach(card);
  }
  function closeNote(open) {
    const n = S.note;
    if (!n) return;
    cat.dismissTeach();
    card.classList.add('out');
    setTimeout(() => {
      card.hidden = true;
      S.note = null;
      if (S.queue.length) setTimeout(() => notify(S.queue.shift()), 900);
    }, 220);
    if (open && n.chatId) openChat(n.chatId);
  }
  $('ntOk').addEventListener('click', () => closeNote(false));
  $('ntOpen').addEventListener('click', () => closeNote(true));

  // ---------- settings ----------
  const dlg = $('settingsDialog');
  const setNote = (t) => { $('setNote').textContent = t || ''; };
  function applySettings(st) {
    if (!st) return;
    S.settings = st;
    renderHeader();
    renderStatus();
    renderBalance();
    if (dlg.open) fillSettings();
  }
  function pill(id, st, extra) {
    const p = $(id);
    p.textContent = (MODE_TEXT[st.mode] || st.mode) + (extra || '');
    p.className = `pill ${st.mode}`;
  }
  function fillSettings() {
    const st = S.settings;
    for (const r of document.querySelectorAll('input[name=tmode]')) r.checked = r.value === st.terminal.mode;
    // OpenRouter
    if (document.activeElement !== $('orModel')) $('orModel').value = st.openrouter.model;
    $('orModels').innerHTML = (st.status.orModels || []).map((m) => `<option value="${m.id}">${m.label} — ${m.note}</option>`).join('');
    $('orThinking').checked = st.openrouter.thinking;
    $('orEffort').value = ['low', 'medium', 'high'].includes(st.openrouter.effort) ? st.openrouter.effort : 'high';
    $('orEffort').disabled = !st.openrouter.thinking;
    if (document.activeElement !== $('orPin')) $('orPin').value = st.openrouter.pin || '';
    $('orFallbacks').checked = !!st.openrouter.allowFallbacks;
    const or = st.status.openrouter;
    pill('orState', or, or.balance ? ` · ${or.balance}` : '');
    $('orHint').textContent = st.hasKey.openrouter ? 'Key saved (encrypted with the macOS keychain).'
      : st.hasKey.openrouterEnv ? 'Using OPENROUTER_API_KEY from the environment.'
        : 'One key for many models/providers — often easier to pay with a RU card. Get it at openrouter.ai/keys. Pin a provider (e.g. streamlake/fp8) to lock price, or leave blank to auto-route to the cheapest.';
    $('defCwd').textContent = tilde(st.terminal.defaultCwd);
    $('defCwd').title = st.terminal.defaultCwd;
    $('shellName').textContent = st.shell;
    renderSkillSettings();
  }
  async function openSettings() {
    applySettings(await may.settings());
    setNote('');
    S.skillEditing = null;
    $('orKey').value = '';
    fillSettings();
    if (!dlg.open) dlg.showModal();
  }
  const update = async (patch) => applySettings(await may.setSettings(patch));
  for (const r of document.querySelectorAll('input[name=tmode]')) r.addEventListener('change', () => update({ terminal: { mode: r.value } }));
  $('orModel').addEventListener('change', () => update({ openrouter: { model: $('orModel').value } }));
  $('orThinking').addEventListener('change', () => update({ openrouter: { thinking: $('orThinking').checked } }));
  $('orEffort').addEventListener('change', () => update({ openrouter: { effort: $('orEffort').value } }));
  $('orPin').addEventListener('change', () => update({ openrouter: { pin: $('orPin').value } }));
  $('orFallbacks').addEventListener('change', () => update({ openrouter: { allowFallbacks: $('orFallbacks').checked } }));
  $('defCwdBtn').addEventListener('click', async () => applySettings(await may.chooseDefaultCwd()));
  // ---------- skills in settings ----------
  function renderSkillSettings() {
    const listEl = $('skillList');
    listEl.textContent = '';
    const list = (S.settings && S.settings.skills) || [];
    if (!list.length) listEl.append(el('div', 'hint', 'No skills yet.'));
    for (const sk of list) {
      const row = el('div', 'skill-row');
      if (S.skillEditing && S.skillEditing.id === sk.id) row.classList.add('editing');
      row.append(el('code', null, `/${slug(sk.name)}`), el('span', 'sr-name', sk.name));
      if (sk.provider) row.append(el('span', 'sr-model', PROVIDER_NAME[sk.provider] || sk.provider));
      row.addEventListener('click', () => openSkillEditor(sk));
      listEl.append(row);
    }
    const editing = !!S.skillEditing;
    $('skillEdit').hidden = !editing;
    $('skNew').hidden = editing;
    $('skDelete').hidden = !(editing && S.skillEditing.id);
    if (editing) {
      $('skName').value = S.skillEditing.name || '';
      $('skPrompt').value = S.skillEditing.prompt || '';
      $('skProvider').value = S.skillEditing.provider || '';
    }
  }
  function openSkillEditor(sk) { S.skillEditing = sk ? { ...sk } : { name: '', prompt: '', provider: '' }; renderSkillSettings(); if (sk) $('skName').focus(); else $('skName').focus(); }
  $('skNew').addEventListener('click', () => openSkillEditor(null));
  $('skCancel').addEventListener('click', () => { S.skillEditing = null; setNote(''); renderSkillSettings(); });
  $('skSave').addEventListener('click', async () => {
    const skill = { id: S.skillEditing && S.skillEditing.id, name: $('skName').value, prompt: $('skPrompt').value, provider: $('skProvider').value };
    const res = await may.saveSkill(skill);
    if (res.error) { setNote(res.error); return; }
    S.settings.skills = res.skills;
    S.skillEditing = null;
    setNote('Skill saved.');
    renderSkillSettings();
  });
  $('skDelete').addEventListener('click', async () => {
    if (!S.skillEditing || !S.skillEditing.id) return;
    S.settings.skills = await may.deleteSkill(S.skillEditing.id);
    S.skillEditing = null;
    setNote('Skill deleted.');
    renderSkillSettings();
  });

  async function saveKey(provider, inputId) {
    const v = $(inputId).value.trim();
    if (!v) return;
    setNote('Checking the key…');
    const st = await may.setKey(provider, v);
    applySettings(st);
    $(inputId).value = '';
    const mode = st.status[provider].mode;
    setNote(st.error || (mode === 'ready' ? `${PROVIDER_NAME[provider]} is ready.` : mode === 'offline' ? `Saved, but ${PROVIDER_NAME[provider]} isn't reachable right now.` : `${PROVIDER_NAME[provider]} did not accept this key.`));
  }
  $('orSave').addEventListener('click', () => saveKey('openrouter', 'orKey'));
  $('orKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveKey('openrouter', 'orKey'); } });
  $('orClear').addEventListener('click', async () => { applySettings(await may.clearKey('openrouter')); setNote('OpenRouter key removed.'); });
  $('settingsBtn').addEventListener('click', openSettings);
  may.onStatus(applySettings);

  // ---------- misc input ----------
  $('newChat').addEventListener('click', newChat);
  $('pane').addEventListener('mousemove', (e) => {
    const r = $('chatScene').getBoundingClientRect();
    S.mouse = [e.clientX - r.left, e.clientY - r.top];
  });
  $('pane').addEventListener('mouseleave', () => { S.mouse = null; });
  $('pane').addEventListener('click', (e) => {
    if (e.target.closest('button, a, textarea, input, .box, .term-box, .menu')) return;
    const r = $('chatScene').getBoundingClientRect();
    cat.hit(e.clientX - r.left, e.clientY - r.top);
  });
  const pendingApproval = () => S.chat && [...S.chat.messages].reverse().find((m) => m.role === 'tool' && m.status === 'approval');
  window.addEventListener('keydown', (e) => {
    if (!S.shown) return;
    if (e.metaKey && e.key === ',') { e.preventDefault(); openSettings(); return; }
    if (dlg.open) return;
    if (e.metaKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
    const ap = pendingApproval();
    if (ap && e.metaKey && e.key === 'Enter') { e.preventDefault(); may.decide(ap.id, 'run'); }
    if (ap && e.metaKey && e.key === 'Backspace' && !input.value) { e.preventDefault(); may.decide(ap.id, 'deny'); }
    if (e.key === 'Escape' && S.note) closeNote(false);
  });

  // ---------- view switching ----------
  function wipe(between) {
    const w = $('wipe');
    if (!w.childElementCount) for (let i = 0; i < 26; i++) w.append(document.createElement('i'));
    [...w.children].forEach((r) => { r.style.animationDelay = `${Math.floor(Math.random() * 4) * 30}ms`; });
    w.className = 'wipe in';
    setTimeout(() => {
      between();
      w.className = 'wipe out';
      setTimeout(() => { w.className = 'wipe'; }, 520);
    }, 440);
  }

  const fps = { n: 0, worst: 0, last: 0 };
  function loop() {
    if (!S.shown) return;
    const tn = performance.now();
    if (fps.last) { fps.n++; fps.worst = Math.max(fps.worst, tn - fps.last); }
    fps.last = tn;
    window.__fps = () => fps;
    cat.update(S.mouse);
    requestAnimationFrame(loop);
  }

  async function enter(instant) {
    const go = async () => {
      document.body.classList.add('in-chat');
      document.getElementById('homeView').hidden = true;
      view.hidden = false;
      S.shown = true;
      requestAnimationFrame(loop);
      balCat.start();
      if (!S.settings) applySettings(await may.settings());
      if (!S.chat) {
        await refreshList();
        if (S.chats.length) await openChat(S.chats[0].id);
        else await newChat();
      } else cat.reanchor();
      while (S.queue.length && !S.note) notify(S.queue.shift());
      refreshBalance();
      if (!S.balTimer) S.balTimer = setInterval(() => { if (S.shown && !document.hidden) refreshBalance(); }, 60000);
    };
    if (instant) await go(); else wipe(go);
  }
  function leave() {
    wipe(() => {
      S.shown = false;
      balCat.stop();
      clearInterval(S.balTimer); S.balTimer = null;
      view.hidden = true;
      document.getElementById('homeView').hidden = false;
      document.body.classList.remove('in-chat');
    });
  }
  $('toHome').addEventListener('click', leave);
  $('balRefresh').addEventListener('click', refreshBalance);
  $('balance').addEventListener('click', (e) => { if (e.target.id !== 'balRefresh') openSettings(); });

  may.settings().then(applySettings);

  // QA hooks
  window.__chat = {
    send, openChat, newChat, openSettings, state: S, cat,
    notifyTest: (text) => notify({ kind: 'reminder', chatId: S.chat && S.chat.id, title: 'Reminder', text }),
    scroll: (y) => { thread.scrollTop = y; },
    click: (sel) => { const b = document.querySelector(sel); if (b) b.click(); return !!b; },
  };

  return { enter, leave };
})();
