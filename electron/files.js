// File and system access for the agent: read / write / edit files on disk, open a file, folder,
// URL or a system app with the OS default handler, and download a URL to disk. Pure Node (no shell),
// so these are predictable and injection-free; paths resolve against the chat's working folder.
// Cross-platform: macOS (`open`), Linux (`xdg-open` / launch a binary), Windows (`start`).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_READ = 400000;   // bytes read from disk for a read_file
const MAX_SHOWN = 60000;   // chars kept in the card / handed to the model
const MAX_WRITE = 5_000_000; // chars accepted for write_file / a single edit
const MAX_DOWNLOAD = 500 * 1024 * 1024; // 500 MB ceiling for a download

const PLATFORM = process.platform; // 'darwin' | 'linux' | 'win32'
const osName = () => (PLATFORM === 'darwin' ? 'Mac' : PLATFORM === 'win32' ? 'Windows' : 'Linux');

// Resolve a model-supplied path against the chat's working folder; expand a leading ~.
function resolve(p, cwd) {
  let s = String(p || '').trim();
  if (!s) return null;
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(cwd || os.homedir(), s);
}
const tilde = (p) => (p && p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);
const lineCount = (s) => (s.length ? s.replace(/\n$/, '').split('\n').length : 0); // a trailing newline isn't a line
const trimShown = (s) => (s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN / 3)}\n… [${s.length - MAX_SHOWN} characters omitted] …\n${s.slice(-(MAX_SHOWN * 2) / 3)}` : s);

// ---------- read ----------
function readFile(abs) {
  let st;
  try { st = fs.statSync(abs); } catch (_) { return { ok: false, output: `No such file: ${tilde(abs)}` }; }
  if (st.isDirectory()) {
    const items = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 500)
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).sort();
    return { ok: true, output: `${tilde(abs)} is a folder (${items.length} entries):\n${items.join('\n')}` };
  }
  if (st.size > MAX_READ) return { ok: false, output: `File is too large to read in full (${st.size} bytes). Read it in parts with run_command (e.g. sed -n).` };
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) return { ok: false, output: `${tilde(abs)} looks binary (${st.size} bytes); not shown as text.` };
  const text = buf.toString('utf8');
  const lines = lineCount(text);
  return { ok: true, output: `${tilde(abs)} · ${st.size} bytes · ${lines} lines\n--- contents ---\n${trimShown(text) || '(empty file)'}` };
}

// ---------- write ----------
function writeFile(abs, content) {
  const existed = fs.existsSync(abs);
  if (existed && fs.statSync(abs).isDirectory()) return { ok: false, output: `${tilde(abs)} is a folder, not a file.` };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  const lines = lineCount(content);
  return { ok: true, output: `${existed ? 'Overwrote' : 'Created'} ${tilde(abs)} · ${Buffer.byteLength(content)} bytes · ${lines} lines` };
}

// ---------- edit (exact string replacement) ----------
function editFile(abs, oldStr, newStr, replaceAll) {
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch (_) { return { ok: false, output: `Cannot read ${tilde(abs)} (does it exist?). Use write_file to create a new file.` }; }
  if (oldStr === newStr) return { ok: false, output: 'old_string and new_string are identical; nothing to change.' };
  const count = text.split(oldStr).length - 1;
  if (count === 0) return { ok: false, output: 'old_string was not found in the file. It must match exactly, including whitespace.' };
  if (count > 1 && !replaceAll) return { ok: false, output: `old_string appears ${count} times. Make it unique, or pass replace_all: true to replace every occurrence.` };
  const updated = replaceAll ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
  fs.writeFileSync(abs, updated, 'utf8');
  // show the first changed region so the user can see what happened
  const at = updated.indexOf(newStr);
  const from = updated.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
  let to = updated.indexOf('\n', at + newStr.length);
  if (to < 0) to = updated.length;
  const snippet = updated.slice(from, to);
  return { ok: true, output: `Edited ${tilde(abs)} · ${replaceAll ? `${count} replacement${count > 1 ? 's' : ''}` : '1 replacement'}\n--- updated region ---\n${trimShown(snippet)}` };
}

// ---------- open a file / folder / URL / system app ----------
// Launches detached so the app keeps running after the command returns; no shell, so nothing in the
// target is interpreted. A bare name (no path separator, no scheme, not an existing path) is treated
// as an application / tool to launch; everything else is handed to the OS default handler.
function openPath(target, cwd) {
  const t = String(target || '').trim();
  if (!t) return { ok: false, output: 'Nothing to open.' };
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(t);
  const abs = isUrl ? null : resolve(t, cwd);
  const looksLikePath = isUrl || t.includes('/') || t.includes(path.sep) || (abs && fs.existsSync(abs));
  const asApp = !looksLikePath; // e.g. "Calculator", "firefox", "gnome-calculator"

  let cmd; let args; let what;
  if (PLATFORM === 'darwin') {
    cmd = 'open';
    args = asApp ? ['-a', t] : [isUrl ? t : abs];
    what = asApp ? `app ${t}` : isUrl ? t : tilde(abs);
  } else if (PLATFORM === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', isUrl ? t : asApp ? t : abs];
    what = asApp ? `app ${t}` : isUrl ? t : tilde(abs);
  } else { // linux & others
    if (asApp) { cmd = t; args = []; what = `app ${t}`; }
    else { cmd = 'xdg-open'; args = [isUrl ? t : abs]; what = isUrl ? t : tilde(abs); }
  }

  if (!isUrl && !asApp && !fs.existsSync(abs)) return { ok: false, output: `No such file or folder: ${tilde(abs)}` };
  try {
    const child = spawn(cmd, args, { cwd: cwd || os.homedir(), detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // a missing launcher/app shouldn't crash the agent
    child.unref();
    return { ok: true, output: `Opened ${what} on ${osName()}.` };
  } catch (err) {
    return { ok: false, output: `Could not open ${what}: ${err.message}` };
  }
}

// ---------- download a URL to disk ----------
async function download(url, dest, cwd) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, output: 'url must be an http:// or https:// address.' };
  const abs = resolve(dest, cwd);
  if (!abs) return { ok: false, output: 'A destination path is required.' };
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return { ok: false, output: `${tilde(abs)} is a folder; give a destination file path.` };
  let res;
  try { res = await fetch(u, { redirect: 'follow' }); } catch (err) { return { ok: false, output: `Download failed: ${err.message}` }; }
  if (!res.ok) return { ok: false, output: `Download failed: HTTP ${res.status} ${res.statusText}` };
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > MAX_DOWNLOAD) return { ok: false, output: `File is ${len} bytes, over the ${MAX_DOWNLOAD}-byte limit.` };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD) return { ok: false, output: `Downloaded ${buf.length} bytes, over the ${MAX_DOWNLOAD}-byte limit; discarded.` };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return { ok: true, output: `Downloaded ${buf.length} bytes → ${tilde(abs)}` };
}

// A short, human-readable line for the tool card (shown next to a per-tool glyph).
function label(name, v) {
  if (name === 'read_file') return `read ${v.path}`;
  if (name === 'write_file') return `write ${v.path}`;
  if (name === 'edit_file') return `edit ${v.path}`;
  if (name === 'open_path') return `open ${v.target}`;
  if (name === 'download_file') return `download ${v.url} → ${v.dest}`;
  return name;
}

module.exports = { resolve, readFile, writeFile, editFile, openPath, download, label, tilde, osName, MAX_WRITE };
