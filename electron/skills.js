// Skills: reusable named playbooks the user can invoke with /name in the composer.
// A skill is { id, name, prompt, provider }. provider '' means "use the chat's current model".
const crypto = require('crypto');

const id = () => crypto.randomBytes(6).toString('hex');
const PROVIDERS = ['', 'openrouter'];

// Seeded on first run so Skills isn't empty. The user can edit or delete any of these.
const DEFAULTS = [
  { name: 'Review changes', provider: '', prompt: 'Run git status and git diff in the working folder, then summarise what changed — grouped by area — and flag anything that looks risky, unfinished, or accidentally committed. Do not change any files.' },
  { name: 'Explain this folder', provider: '', prompt: 'List the files in the working folder and explain what this project is, how it is structured, and where the important entry points are. Read a few key files if that helps. Keep it to a short tour.' },
  { name: 'Plan my day', provider: '', prompt: 'Help me plan today. If you do not already know them, ask me for my top 2-3 priorities, then propose a realistic time-boxed schedule and offer to set reminders for the key blocks.' },
  { name: 'Fix failing tests', provider: '', prompt: "Work out how this project's tests are run, run them, and if any fail, investigate and fix the cause. Work in small, verifiable steps and show me the change before any large edit." },
];

const name = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
// a short token used for /name matching
const slug = (s) => name(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function seed() {
  return DEFAULTS.map((s) => ({ id: id(), name: s.name, provider: s.provider, prompt: s.prompt }));
}

// Returns { ok, value } or { ok:false, error }. Used for both create (no id) and update (with id).
function validate(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid skill.' };
  const nm = name(input.name);
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!nm || nm.length > 60) return { ok: false, error: 'Name must be 1–60 characters.' };
  if (!prompt || prompt.length > 8000) return { ok: false, error: 'Instruction must be 1–8000 characters.' };
  const provider = PROVIDERS.includes(input.provider) ? input.provider : ''; // unknown/removed provider -> chat default
  return { ok: true, value: { id: typeof input.id === 'string' ? input.id : id(), name: nm, provider, prompt } };
}

function upsert(list, input) {
  const v = validate(input);
  if (!v.ok) return v;
  const skills = Array.isArray(list) ? list.slice() : [];
  const i = skills.findIndex((s) => s.id === v.value.id);
  if (i >= 0) skills[i] = v.value; else skills.push(v.value);
  return { ok: true, value: v.value, list: skills };
}

// Parse a composer line: "/review rest of my message" -> { skill, rest } (skill may be null).
function match(list, text) {
  const m = String(text || '').match(/^\/([\w-]*)\s*([\s\S]*)$/);
  if (!m) return null;
  const q = m[1].toLowerCase();
  const rest = m[2];
  const skills = Array.isArray(list) ? list : [];
  const exact = skills.find((s) => slug(s.name) === q);
  return { query: q, rest, skill: exact || null, candidates: filter(skills, q) };
}

// Fuzzy-ish filter for the dropdown: slug prefix first, then substring of name.
function filter(list, q) {
  const skills = Array.isArray(list) ? list : [];
  if (!q) return skills;
  const pre = [], sub = [];
  for (const s of skills) {
    const sl = slug(s.name);
    if (sl.startsWith(q)) pre.push(s);
    else if (sl.includes(q) || name(s.name).toLowerCase().includes(q)) sub.push(s);
  }
  return pre.concat(sub);
}

module.exports = { seed, validate, upsert, match, filter, slug, PROVIDERS, DEFAULTS };
