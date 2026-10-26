// Runs shell commands for the agent: non-interactive login zsh, working directory carried between
// commands, live output, timeout, whole-process-group kill, ANSI stripped, output capped.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const MARK = '__MAY_CWD__';
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const HEAD = 20000;
const TAIL = 60000;

const shellPath = () => (process.env.SHELL && /\/(zsh|bash)$/.test(process.env.SHELL) ? process.env.SHELL : '/bin/zsh');
const dirOk = (d) => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } };
const tilde = (p) => (p && p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);

// Clean terminal output: strip colors, collapse carriage-return progress bars to their last frame.
function clean(s) {
  return s.replace(ANSI, '').replace(/\r\n/g, '\n').split('\n').map((l) => (l.includes('\r') ? l.slice(l.lastIndexOf('\r') + 1) : l)).join('\n');
}

function run({ command, cwd, timeoutMs = 120000, onData = () => {} }) {
  const startDir = dirOk(cwd) ? cwd : os.homedir();
  // the EXIT trap reports where the shell ended up, even when the command calls `exit`
  const script = `trap 'printf "\\n${MARK}%s\\n" "$PWD"' EXIT\n${command}`;
  const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1', CLICOLOR: '0', PAGER: 'cat', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', HOMEBREW_NO_AUTO_UPDATE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  const t0 = Date.now();
  const child = spawn(shellPath(), ['-lc', script], { cwd: startDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let head = '', tail = '', total = 0, newCwd = null, timedOut = false, killed = false, carry = '';

  const take = (raw) => {
    let s = clean(carry + raw);
    // hold back an unfinished last line so the cwd marker never leaks into the visible output
    const cut = s.lastIndexOf('\n');
    carry = cut < 0 ? s : s.slice(cut + 1);
    s = cut < 0 ? '' : s.slice(0, cut + 1);
    if (carry.length > 4000) { s += carry; carry = ''; }
    s = s.replace(new RegExp(`\\n?${MARK}([^\\n]*)\\n?`, 'g'), (_, d) => { newCwd = d; return ''; });
    if (!s) return;
    onData(s);
    total += s.length;
    if (head.length < HEAD) {
      const room = HEAD - head.length;
      head += s.slice(0, room);
      s = s.slice(room);
    }
    if (s) tail = (tail + s).slice(-TAIL);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', take);
  child.stderr.on('data', take);

  const killTree = (sig) => { try { process.kill(-child.pid, sig); } catch (_) { try { child.kill(sig); } catch (__) { /* gone */ } } };
  const kill = () => {
    if (child.exitCode != null || killed) return;
    killed = true;
    killTree('SIGTERM');
    setTimeout(() => killTree('SIGKILL'), 1500);
  };
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);

  const promise = new Promise((resolve) => {
    child.on('error', (err) => { clearTimeout(timer); resolve({ exitCode: null, error: err.message, output: err.message, cwd: startDir, timedOut, killed, durationMs: Date.now() - t0, truncated: 0 }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (carry) { take('\n'); }
      const omitted = Math.max(0, total - head.length - tail.length);
      const output = omitted ? `${head}\n… [${omitted} characters omitted] …\n${tail}` : head + tail;
      resolve({
        exitCode: code,
        signal,
        timedOut,
        killed: killed && !timedOut,
        cwd: newCwd && dirOk(newCwd) ? newCwd : startDir,
        output,
        truncated: omitted,
        durationMs: Date.now() - t0,
      });
    });
  });
  return { promise, kill, pid: child.pid };
}

// What the model sees: exit status, where the shell ended up, and output trimmed to head + tail.
function forModel(r, limit = 12000) {
  let out = r.output || '';
  if (out.length > limit) out = `${out.slice(0, limit / 3)}\n… [${out.length - limit} characters omitted] …\n${out.slice(-(limit * 2) / 3)}`;
  const status = r.timedOut ? 'timed out (killed)' : r.killed ? 'stopped by the user' : r.error ? `failed to start: ${r.error}` : `exit code ${r.exitCode}`;
  return `${status}\ncwd: ${r.cwd}\n--- output ---\n${out.trim() ? out : '(no output)'}`;
}

// ---------- approval helpers ----------
const READ_ONLY = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'which', 'whoami', 'date', 'echo',
  'file', 'stat', 'du', 'df', 'tree', 'uname', 'sw_vers', 'printenv', 'id', 'uptime', 'cal', 'type']);
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame', 'describe', 'tag']);
const VERSIONED = new Set(['node', 'npm', 'npx', 'python', 'python3', 'pip', 'pip3', 'ruby', 'go', 'cargo', 'rustc', 'java', 'deno', 'bun', 'git', 'brew', 'docker', 'yarn', 'pnpm']);

function isReadOnly(cmd) {
  const c = cmd.trim();
  if (!c || /[;&|<>`$(){}\n]/.test(c)) return false;
  const [w0, w1] = c.split(/\s+/);
  if (w0 === 'git') return GIT_READ.has(w1) && !/--output|-o\s/.test(c);
  if (w0 === 'find') return !/-(exec|execdir|delete|ok|fprint)/.test(c);
  if (VERSIONED.has(w0) && /^(--version|-v|-V|version)$/.test(w1 || '')) return true;
  if (w0 === 'npm' && /^(ls|list|view|outdated)$/.test(w1 || '')) return true;
  return READ_ONLY.has(w0);
}

const DANGER = [
  /\bsudo\b/, /\bsu\s/, /\brm\s+(-\w+\s+)*-\w*[rR]\w*\s+(-\w+\s+)*(\/|~|\$HOME|\*|\.\s*$|\.\.)(\s|\/?\s*$)/,
  /\bmkfs\b/, /\bdd\s+.*\bof=/, /:\(\)\s*\{/, /\b(shutdown|reboot|halt)\b/, /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/,
  /\bdiskutil\s+(erase|partition|zero)/i, /\bchmod\s+-R\s+[0-7]*7[0-7]*\s+\//, /\bgit\s+push\b.*(--force|-f)\b/, /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-\w*f/, />\s*\/dev\/(disk|sd)/, /\blaunchctl\b/, /\bcsrutil\b/, /\bsecurity\s+(delete|dump)/,
];
const isDangerous = (cmd) => DANGER.some((re) => re.test(cmd));

module.exports = { run, forModel, isReadOnly, isDangerous, tilde, dirOk };
