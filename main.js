const { app, BrowserWindow, ipcMain, safeStorage, Notification, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Store, id: newId } = require('./electron/store');
const { Agent, PROVIDERS } = require('./electron/agent');
const DS = require('./electron/providers/deepseek');
const OR = require('./electron/providers/openrouter');
const { validate } = require('./electron/providers/shared');
const terminal = require('./electron/terminal');
const skills = require('./electron/skills');
const files = require('./electron/files');

// QA modes:
//   electron . --shots=0.5,2,12 --out=./shots [--size=1440x900]        home timeline frames
//   electron . --script=steps.json --out=./shots --userdata=./tmp-data  scripted chat session
//     steps: [{ "js": "..." } | { "wait": 500 } | { "shot": "name" }]
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const shots = arg('shots');
const script = arg('script');
const offscreen = !!(shots || script);
const outDir = arg('out') || path.join(__dirname, 'shots');
const [W, H] = (arg('size') || '1440x900').split('x').map(Number);
if (arg('userdata')) app.setPath('userData', path.resolve(arg('userdata')));

let win = null;
let store = null;
const agent = new Agent();
const turns = new Map();     // chatId -> abort signal of the running turn
const approvals = new Map(); // tool message id -> { resolve, chat }
const jobs = new Map();      // tool message id -> running terminal job
let openChatId = null;

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const emit = (type, chatId, extra = {}) => send('chat:event', { type, chatId, ...extra });

function systemNotify(title, body) {
  if (win && !win.isFocused() && !offscreen && Notification.isSupported()) new Notification({ title, body }).show();
}

// ---------- settings & credentials ----------
const S = () => store.data.settings;
const KEY_FIELD = { claude: 'apiKey', deepseek: 'deepseekKey', openrouter: 'openrouterKey' };
function getSkills() {
  const st = S();
  if (!Array.isArray(st.skills)) st.skills = skills.seed();
  // a skill pinned to a provider we no longer offer falls back to the chat's current model
  for (const sk of st.skills) if (sk.provider && !PROVIDERS.includes(sk.provider)) sk.provider = '';
  return st.skills;
}
function settingsView() {
  const st = S();
  return {
    provider: st.provider || 'openrouter',
    deepseek: { ...DS.DEFAULTS, ...(st.deepseek || {}) },
    openrouter: { ...OR.DEFAULTS, ...(st.openrouter || {}) },
    terminal: { mode: 'ask', defaultCwd: os.homedir(), ...(st.terminal || {}) },
    hasKey: { claude: !!st.apiKey, deepseek: !!st.deepseekKey, deepseekEnv: !!process.env.DEEPSEEK_API_KEY, openrouter: !!st.openrouterKey, openrouterEnv: !!process.env.OPENROUTER_API_KEY },
    status: agent.status(),
    shell: path.basename(process.env.SHELL || '/bin/zsh'),
    home: os.homedir(),
    skills: getSkills(),
  };
}
function decrypt(enc) {
  if (!enc || !safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch (_) { return null; }
}
async function refreshAgent() {
  agent.configure({ claudeKey: decrypt(S().apiKey), deepseekKey: decrypt(S().deepseekKey), openrouterKey: decrypt(S().openrouterKey), deepseek: settingsView().deepseek, openrouter: settingsView().openrouter });
  await agent.check();
  send('status', settingsView());
  return settingsView();
}

// ---------- chats ----------
function ensureChat(c) {
  if (!c.native) {
    c.native = { claude: c.api || [] };
    c.seen = { claude: c.api ? c.messages.length : 0 };
    delete c.api;
  }
  c.seen = c.seen || {};
  for (const prov of PROVIDERS) { if (!c.native[prov]) c.native[prov] = []; if (c.seen[prov] == null) c.seen[prov] = 0; }
  c.cwdTold = c.cwdTold || {};
  if (!c.provider || !PROVIDERS.includes(c.provider)) c.provider = settingsView().provider;
  if (!c.cwd || !terminal.dirOk(c.cwd)) c.cwd = settingsView().terminal.defaultCwd;
  return c;
}
const chatView = (c) => ({ id: c.id, title: c.title, messages: c.messages, busy: turns.has(c.id), provider: c.provider, cwd: c.cwd, autoApprove: !!c.autoApprove });

// What happened since this provider last answered (other model's replies, user's own commands,
// the working folder) goes in front of the new question as one <context> block.
function contextFor(c, p, text, upto) {
  const parts = [];
  if (c.cwdTold[p] !== c.cwd) { parts.push(`Working folder: ${c.cwd}`); c.cwdTold[p] = c.cwd; }
  const cut = (s, n) => (s.length > n ? `${s.slice(0, n / 3)}\n…\n${s.slice(-(n * 2) / 3)}` : s);
  for (const m of c.messages.slice(c.seen[p] || 0, upto)) {
    if (m.role === 'user') parts.push(`User said: ${cut(m.text, 3000)}`);
    else if (m.role === 'assistant' && m.text) parts.push(`Reply from ${ { claude: 'Claude', deepseek: 'DeepSeek', openrouter: 'OpenRouter' }[m.provider] || 'another model'}: ${cut(m.text, 3000)}`);
    else if (m.role === 'tool') {
      const who = m.by === 'user' ? 'The user ran' : 'Another model ran';
      parts.push(`${who} \`${m.command}\` in ${m.cwd} → ${m.status === 'done' ? `exit ${m.exitCode}` : m.status}\n${cut(m.output || '', 3000)}`);
    } else if (m.role === 'notice') parts.push(`Reminder fired: ${m.text}`);
  }
  return parts.length ? `<context>\n${parts.join('\n\n')}\n</context>\n\n${text}` : text;
}

function removeMessage(c, m) {
  c.messages = c.messages.filter((x) => x !== m);
  emit('remove', c.id, { messageId: m.id });
}

// ---------- reminders ----------
function scheduleReminder(r) {
  const ms = Math.max(0, r.dueAt - Date.now());
  setTimeout(() => fireReminder(r.id), Math.min(ms, 2147483000));
}
function fireReminder(rid) {
  const r = store.data.reminders.find((x) => x.id === rid);
  if (!r) return;
  if (r.dueAt > Date.now() + 1000) return scheduleReminder(r);
  store.data.reminders = store.data.reminders.filter((x) => x.id !== rid);
  const c = store.chat(r.chatId);
  const msg = c ? store.addMessage(c, { role: 'notice', kind: 'reminder', text: r.message }) : null;
  store.save();
  send('notify', { id: r.id, kind: 'reminder', chatId: r.chatId, title: 'Reminder', text: r.message, message: msg });
  systemNotify('May May reminds you', r.message);
}
function addReminder(c, { message, delay }) {
  const rem = { id: newId(), chatId: c.id, message, dueAt: Date.now() + delay * 1000 };
  store.data.reminders.push(rem);
  store.save();
  scheduleReminder(rem);
  return `Reminder scheduled for ${new Date(rem.dueAt).toLocaleTimeString()}.`;
}

// ---------- terminal ----------
function needsApproval(c, cmd) {
  if (terminal.isDangerous(cmd)) return true;
  const mode = settingsView().terminal.mode;
  if (c.autoApprove || mode === 'all') return false;
  return !(mode === 'safe' && terminal.isReadOnly(cmd));
}

async function runTerminal(c, { command, timeout }, signal, by) {
  const tm = store.addMessage(c, { role: 'tool', tool: 'terminal', by, command, cwd: c.cwd, status: 'pending', output: '', provider: by === 'ai' ? c.provider : null });
  emit('message', c.id, { message: tm });

  let decision = 'run';
  if (by === 'ai' && needsApproval(c, command)) {
    tm.status = 'approval';
    tm.danger = terminal.isDangerous(command);
    emit('update', c.id, { message: tm });
    systemNotify('May May wants to run a command', command.slice(0, 140));
    decision = await new Promise((resolve) => {
      approvals.set(tm.id, { resolve, chat: c });
      signal.onAbort(() => resolve('stop'));
    });
    approvals.delete(tm.id);
  } else if (by === 'ai') tm.auto = true;

  if (decision !== 'run' || signal.aborted) {
    tm.status = decision === 'deny' ? 'denied' : 'stopped';
    emit('update', c.id, { message: tm });
    store.save();
    return decision === 'deny'
      ? { text: 'The user declined to run this command. Do not retry it; ask how they would like to proceed.', error: true }
      : { text: 'Stopped by the user before running.', error: true };
  }

  tm.status = 'running';
  tm.startedAt = Date.now();
  emit('update', c.id, { message: tm });
  const job = terminal.run({
    command,
    cwd: c.cwd,
    timeoutMs: timeout * 1000,
    onData: (chunk) => {
      tm.output = (tm.output + chunk).slice(-60000);
      emit('output', c.id, { messageId: tm.id, chunk });
    },
  });
  jobs.set(tm.id, job);
  signal.onAbort(job.kill);
  const r = await job.promise;
  jobs.delete(tm.id);
  tm.output = r.output.length > 60000 ? `${r.output.slice(0, 20000)}\n…\n${r.output.slice(-40000)}` : r.output;
  tm.exitCode = r.exitCode;
  tm.durationMs = r.durationMs;
  tm.status = r.timedOut ? 'timeout' : r.killed ? 'stopped' : r.error ? 'error' : 'done';
  tm.cwdAfter = r.cwd;
  c.cwd = r.cwd;
  emit('update', c.id, { message: tm, cwd: c.cwd });
  store.save();
  return { text: terminal.forModel(r) };
}

// ---------- file & system tools ----------
// read_file is read-only (same approval rules as a read-only command); the rest touch the machine.
const FILE_READONLY = new Set(['read_file']);
const SYS_ROOTS = process.platform === 'win32'
  ? [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles || 'C:\\Program Files']
  : ['/System', '/usr', '/bin', '/sbin', '/etc', '/boot'];
function underSystem(abs) {
  if (!abs) return false;
  const p = process.platform === 'win32' ? abs.toLowerCase() : abs;
  return SYS_ROOTS.some((root) => {
    const r = process.platform === 'win32' ? root.toLowerCase() : root;
    return p === r || p.startsWith(`${r}${path.sep}`) || p.startsWith(`${r}/`);
  });
}
function fileToolRisk(c, name, v) {
  if (FILE_READONLY.has(name)) return { readOnly: true, danger: false };
  let danger = false;
  if (name === 'write_file' || name === 'edit_file') danger = underSystem(files.resolve(v.path, c.cwd));
  else if (name === 'download_file') danger = underSystem(files.resolve(v.dest, c.cwd));
  return { readOnly: false, danger };
}
function needsFileApproval(c, risk) {
  if (risk.danger) return true;
  const mode = settingsView().terminal.mode;
  if (c.autoApprove || mode === 'all') return false;
  return !(mode === 'safe' && risk.readOnly);
}
const FILE_VERB = { read_file: 'read a file', write_file: 'write a file', edit_file: 'edit a file', open_path: 'open something', download_file: 'download a file' };

async function runFileTool(c, name, v, signal) {
  const risk = fileToolRisk(c, name, v);
  const tm = store.addMessage(c, { role: 'tool', tool: name, by: 'ai', command: files.label(name, v), cwd: c.cwd, status: 'pending', output: '', provider: c.provider });
  emit('message', c.id, { message: tm });

  let decision = 'run';
  if (needsFileApproval(c, risk)) {
    tm.status = 'approval';
    tm.danger = risk.danger;
    emit('update', c.id, { message: tm });
    systemNotify(`May May wants to ${FILE_VERB[name] || 'do something'}`, files.label(name, v).slice(0, 140));
    decision = await new Promise((resolve) => {
      approvals.set(tm.id, { resolve, chat: c });
      signal.onAbort(() => resolve('stop'));
    });
    approvals.delete(tm.id);
  } else tm.auto = true;

  if (decision !== 'run' || signal.aborted) {
    tm.status = decision === 'deny' ? 'denied' : 'stopped';
    emit('update', c.id, { message: tm });
    store.save();
    return decision === 'deny'
      ? { text: 'The user declined this action. Do not retry it; ask how they would like to proceed.', error: true }
      : { text: 'Stopped by the user before it ran.', error: true };
  }

  tm.status = 'running';
  tm.startedAt = Date.now();
  emit('update', c.id, { message: tm });
  const t0 = Date.now();
  let r;
  try {
    const abs = (p) => files.resolve(p, c.cwd);
    if (name === 'read_file') r = files.readFile(abs(v.path));
    else if (name === 'write_file') r = files.writeFile(abs(v.path), v.content);
    else if (name === 'edit_file') r = files.editFile(abs(v.path), v.old_string, v.new_string, v.replace_all);
    else if (name === 'open_path') r = files.openPath(v.target, c.cwd);
    else if (name === 'download_file') r = await files.download(v.url, v.dest, c.cwd);
    else r = { ok: false, output: `Unknown tool: ${name}` };
  } catch (err) {
    r = { ok: false, output: `${name} failed: ${err.message}` };
  }
  tm.output = (r.output || '').slice(-60000);
  tm.durationMs = Date.now() - t0;
  tm.status = r.ok ? 'done' : 'error';
  emit('update', c.id, { message: tm });
  store.save();
  return { text: tm.output || (r.ok ? '(done)' : '(failed)'), error: !r.ok };
}

function mkSignal() {
  return { aborted: false, fns: [], onAbort(fn) { this.fns.push(fn); if (this.aborted) fn(); } };
}

// "!cmd" in the composer: the user runs a command directly; the model hears about it next turn.
function userCommand(c, command) {
  if (!command) return null;
  if (c.title === 'New chat') c.title = `$ ${command}`.slice(0, 42);
  const signal = mkSignal();
  turns.set(c.id, signal);
  (async () => {
    await runTerminal(c, { command, timeout: 600 }, signal, 'user');
    turns.delete(c.id);
    c.updatedAt = Date.now();
    store.save();
    emit('done', c.id, { title: c.title, visible: openChatId === c.id, kind: 'command' });
  })();
  return { title: c.title };
}

// ---------- turns ----------
function startTurn(cid, rawText) {
  const c = store.chat(cid);
  const text = String(rawText || '').slice(0, 40000).trim();
  if (!c || !text || turns.has(cid)) return null;
  ensureChat(c);
  if (text.startsWith('!')) return userCommand(c, text.slice(1).trim());

  const p = c.provider;
  const user = store.addMessage(c, { role: 'user', text });
  emit('message', cid, { message: user });
  if (c.title === 'New chat') c.title = text.replace(/\s+/g, ' ').slice(0, 42);
  c.native[p].push({ role: 'user', content: contextFor(c, p, text, c.messages.length - 1) });

  const signal = mkSignal();
  turns.set(cid, signal);
  let ai = null;
  let lastAi = null;
  const usage = { input: 0, output: 0, cached: 0, reasoning: 0 };
  const openAi = () => {
    ai = store.addMessage(c, { role: 'assistant', text: '', reasoning: '', streaming: true, provider: p, model: agent.modelOf(p) });
    lastAi = ai;
    emit('message', cid, { message: ai });
  };
  const closeAi = (keepEmpty) => {
    if (!ai) return;
    ai.streaming = false;
    if (!keepEmpty && !ai.text.trim() && !ai.reasoning.trim()) {
      removeMessage(c, ai);
      if (lastAi === ai) lastAi = null;
    } else emit('update', cid, { message: ai });
    ai = null;
  };
  openAi();

  const hooks = {
    signal,
    onText: (d) => { if (!ai) openAi(); ai.text += d; emit('delta', cid, { messageId: ai.id, delta: d }); },
    onReasoning: (d) => { if (!ai) openAi(); ai.reasoning += d; emit('delta', cid, { messageId: ai.id, delta: d, kind: 'reasoning' }); },
    onUsage: (u) => { for (const k of Object.keys(usage)) usage[k] += u[k] || 0; },
    onStatus: () => send('status', settingsView()),
    onTool: async (name, input) => {
      closeAi(false);
      const v = validate(name, input);
      let out;
      if (!v.ok) out = { text: v.error, error: true };
      else if (name === 'set_reminder') out = { text: addReminder(c, v.value) };
      else if (name === 'run_command') out = await runTerminal(c, v.value, signal, 'ai');
      else out = await runFileTool(c, name, v.value, signal);
      if (!signal.aborted) openAi();
      return out;
    },
  };

  (async () => {
    let error = null;
    try {
      await agent.run(p, c.native[p], hooks, text);
    } catch (err) {
      if (!signal.aborted) error = agent.describe(p, err);
    }
    if (ai) {
      if (error) ai.error = error;
      closeAi(!!error);
    } else if (error) {
      const e = store.addMessage(c, { role: 'assistant', text: '', reasoning: '', error, provider: p, model: agent.modelOf(p) });
      emit('message', cid, { message: e });
    }
    if (lastAi && usage.input + usage.output) { lastAi.usage = usage; emit('update', cid, { message: lastAi }); }
    c.seen[p] = c.messages.length;
    c.updatedAt = Date.now();
    const visible = openChatId === cid;
    if (!visible) c.unread = true;
    store.save();
    turns.delete(cid);
    const final = lastAi ? lastAi.text : '';
    emit('done', cid, { text: final, error, title: c.title, visible });
    if (!error && final) systemNotify(`May May replied · ${c.title}`, final.slice(0, 120));
  })();

  return { title: c.title };
}

function stopTurn(cid) {
  const s = turns.get(cid);
  if (!s) return;
  s.aborted = true;
  s.fns.forEach((fn) => fn());
}

// ---------- IPC ----------
ipcMain.handle('chats:list', () => store.summaries());
ipcMain.handle('chats:get', (_e, cid) => {
  const c = store.chat(cid);
  if (!c) return null;
  ensureChat(c);
  if (c.unread) { c.unread = false; store.save(); }
  return chatView(c);
});
ipcMain.handle('chats:open', (_e, cid) => { openChatId = cid; return true; });
ipcMain.handle('chats:create', () => {
  const c = ensureChat(store.createChat());
  store.save();
  return chatView(c);
});
ipcMain.handle('chats:delete', (_e, cid) => { stopTurn(cid); store.deleteChat(cid); return true; });
ipcMain.handle('chats:setProvider', (_e, cid, provider) => {
  const c = store.chat(cid);
  if (!c || !PROVIDERS.includes(provider) || turns.has(cid)) return null;
  ensureChat(c).provider = provider;
  store.save();
  return chatView(c);
});
ipcMain.handle('chats:chooseCwd', async (_e, cid) => {
  const c = store.chat(cid);
  if (!c) return null;
  ensureChat(c);
  const res = await dialog.showOpenDialog(win, { title: 'Working folder for this chat', defaultPath: c.cwd, properties: ['openDirectory', 'createDirectory'] });
  if (!res.canceled && res.filePaths[0]) { c.cwd = res.filePaths[0]; store.save(); }
  return chatView(c);
});
ipcMain.handle('chats:setCwd', (_e, cid, dir) => {
  const c = store.chat(cid);
  if (!c || !terminal.dirOk(dir)) return null;
  ensureChat(c).cwd = dir;
  store.save();
  return chatView(c);
});
ipcMain.handle('chats:revokeAuto', (_e, cid) => {
  const c = store.chat(cid);
  if (!c) return null;
  c.autoApprove = false;
  store.save();
  return chatView(ensureChat(c));
});
ipcMain.handle('chat:send', (_e, cid, text) => startTurn(cid, text));
ipcMain.handle('chat:stop', (_e, cid) => { stopTurn(cid); return true; });
ipcMain.handle('tool:decide', (_e, mid, decision) => {
  const a = approvals.get(mid);
  if (!a) return false;
  if (decision === 'always') { a.chat.autoApprove = true; store.save(); }
  a.resolve(decision === 'run' || decision === 'always' ? 'run' : 'deny');
  return true;
});
ipcMain.handle('tool:stop', (_e, mid) => { const j = jobs.get(mid); if (j) j.kill(); return !!j; });

ipcMain.handle('status:get', () => settingsView());
ipcMain.handle('settings:get', () => settingsView());
ipcMain.handle('balance:refresh', async () => { await agent.checkOpenRouter(); const v = settingsView(); send('status', v); return v; });
ipcMain.handle('skills:list', () => getSkills());
ipcMain.handle('skills:save', (_e, skill) => {
  const res = skills.upsert(getSkills(), skill);
  if (!res.ok) return { error: res.error, skills: getSkills() };
  S().skills = res.list;
  store.flush();
  send('status', settingsView());
  return { saved: res.value, skills: res.list };
});
ipcMain.handle('skills:delete', (_e, id) => {
  S().skills = getSkills().filter((x) => x.id !== id);
  store.flush();
  send('status', settingsView());
  return getSkills();
});
ipcMain.handle('settings:set', async (_e, patch) => {
  const st = S();
  if (patch.provider && PROVIDERS.includes(patch.provider)) st.provider = patch.provider;
  if (patch.deepseek) {
    const d = { ...settingsView().deepseek, ...patch.deepseek };
    st.deepseek = { model: String(d.model || DS.DEFAULTS.model).trim() || DS.DEFAULTS.model, thinking: !!d.thinking, effort: ['low', 'high', 'max'].includes(d.effort) ? d.effort : 'high' };
  }
  if (patch.openrouter) {
    const o = { ...settingsView().openrouter, ...patch.openrouter };
    st.openrouter = {
      model: String(o.model || OR.DEFAULTS.model).trim() || OR.DEFAULTS.model,
      thinking: !!o.thinking,
      effort: ['low', 'medium', 'high', 'max'].includes(o.effort) ? o.effort : 'high',
      pin: String(o.pin == null ? '' : o.pin).trim(),
      allowFallbacks: !!o.allowFallbacks,
    };
  }
  if (patch.terminal) {
    const t = { ...settingsView().terminal, ...patch.terminal };
    st.terminal = { mode: ['ask', 'safe', 'all'].includes(t.mode) ? t.mode : 'ask', defaultCwd: terminal.dirOk(t.defaultCwd) ? t.defaultCwd : os.homedir() };
  }
  store.flush();
  return refreshAgent();
});
ipcMain.handle('settings:chooseDefaultCwd', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Default working folder', defaultPath: settingsView().terminal.defaultCwd, properties: ['openDirectory', 'createDirectory'] });
  if (!res.canceled && res.filePaths[0]) { S().terminal = { ...settingsView().terminal, defaultCwd: res.filePaths[0] }; store.flush(); }
  return settingsView();
});
ipcMain.handle('settings:setKey', async (_e, provider, key) => {
  const k = String(key || '').trim();
  if (!k || !PROVIDERS.includes(provider)) return settingsView();
  if (!safeStorage.isEncryptionAvailable()) return { ...settingsView(), error: 'Secure storage is unavailable.' };
  S()[KEY_FIELD[provider]] = safeStorage.encryptString(k).toString('base64');
  store.flush();
  return refreshAgent();
});
ipcMain.handle('settings:clearKey', async (_e, provider) => {
  delete S()[KEY_FIELD[provider]];
  store.flush();
  return refreshAgent();
});

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: W,
    height: H,
    minWidth: 1024,
    minHeight: 640,
    useContentSize: true,
    title: 'May Attacker',
    backgroundColor: '#EEECEA',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    show: !offscreen,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      offscreen,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'src', 'index.html'), shots ? { query: { capture: '1' } } : undefined);
  if (shots) runShots(win);
  if (script) runScript(win, JSON.parse(fs.readFileSync(script, 'utf8')));
  if (process.argv.includes('--fps') || process.argv.includes('--fps-chat')) {
    if (process.argv.includes('--fps-chat')) win.webContents.once('did-finish-load', () => win.webContents.executeJavaScript('window.MayChat.enter(true)'));
    setTimeout(async () => {
      const a = await win.webContents.executeJavaScript('({...window.__fps()})');
      setTimeout(async () => {
        const b = await win.webContents.executeJavaScript('({...window.__fps()})');
        console.log('fps', (b.n - a.n) / 5, 'worst frame ms', b.worst.toFixed(1));
        app.quit();
      }, 5000);
    }, 4000);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function capture(name) {
  const img = await win.webContents.capturePage();
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, img.resize({ width: W, height: H }).toPNG());
  console.log('saved', file);
}

async function runShots(w) {
  await new Promise((r) => w.webContents.once('did-finish-load', r));
  await sleep(1500);
  fs.mkdirSync(outDir, { recursive: true });
  if (process.argv.includes('--bench')) console.log('ms/frame', await w.webContents.executeJavaScript('window.__bench(90)'));
  for (const tok of shots.split(',')) {
    // "cta@12" / "cat@12" / "hover@12" fire an interaction at frozen time 12 (no capture)
    const ev = tok.match(/^(\w+)@([\d.]+)$/);
    if (ev) {
      await w.webContents.executeJavaScript(`window.__freeze(${ev[2]}); window.__poke('${ev[1]}')`);
      continue;
    }
    const t = Number(tok);
    await w.webContents.executeJavaScript(`window.__freeze && window.__freeze(${t})`);
    await sleep(400);
    await capture(`t${String(t).replace('.', '_')}`);
  }
  app.quit();
}

async function runScript(w, steps) {
  await new Promise((r) => w.webContents.once('did-finish-load', r));
  await sleep(800);
  fs.mkdirSync(outDir, { recursive: true });
  for (const s of steps) {
    try {
      if (s.wait) await sleep(s.wait);
      if (s.js) {
        const res = await Promise.race([
          w.webContents.executeJavaScript(s.js),
          sleep(8000).then(() => '<timeout>'),
        ]);
        if (res !== undefined) console.log('js:', JSON.stringify(res));
      }
      if (s.shot) await capture(s.shot);
    } catch (err) {
      console.log('step error:', s.js || s.shot || JSON.stringify(s), '->', err && err.message);
    }
  }
  store.flush();
  app.quit();
}

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  for (const r of store.data.reminders) scheduleReminder(r);
  createWindow();
  refreshAgent();
});
app.on('before-quit', () => {
  for (const j of jobs.values()) j.kill();
  if (store) store.flush();
});
app.on('window-all-closed', () => app.quit());
