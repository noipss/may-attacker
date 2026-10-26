// May May's brain: picks the provider for a chat (Claude or DeepSeek), checks credentials,
// and falls back to a local demo when no key is available.
const { Anthropic, MODEL: CLAUDE_MODEL, EFFORT: CLAUDE_EFFORT, runClaude, describeClaude, noClaudeCredentials } = require('./providers/claude');
const DS = require('./providers/deepseek');
const OR = require('./providers/openrouter');

const PROVIDERS = ['openrouter']; // single user-facing provider; deepseek/claude loops kept for tests

class Agent {
  constructor() {
    this.claude = null;
    this.ds = null;
    this.dsKey = null;
    this.dsCfg = { ...DS.DEFAULTS };
    this.or = null;
    this.orKey = null;
    this.orCfg = { ...OR.DEFAULTS };
    this.state = { claude: { mode: 'checking' }, deepseek: { mode: 'checking' }, openrouter: { mode: 'checking' } };
  }

  // keys: decrypted stored keys (may be null). Env vars and `ant` profiles are picked up as fallbacks.
  configure({ claudeKey, deepseekKey, openrouterKey, deepseek, openrouter, clientOptions = {} }) {
    this.claude = claudeKey ? new Anthropic({ apiKey: claudeKey, ...(clientOptions.claude || {}) }) : new Anthropic(clientOptions.claude || {});
    this.dsKey = deepseekKey || process.env.DEEPSEEK_API_KEY || null;
    this.ds = this.dsKey ? DS.makeClient(this.dsKey, clientOptions.deepseek) : null;
    this.dsCfg = { ...DS.DEFAULTS, ...(deepseek || {}) };
    this.orKey = openrouterKey || process.env.OPENROUTER_API_KEY || null;
    this.or = this.orKey ? OR.makeClient(this.orKey, clientOptions.openrouter) : null;
    this.orCfg = { ...OR.DEFAULTS, ...(openrouter || {}) };
  }

  async check() {
    await this.checkOpenRouter();
    return this.status();
  }
  async checkClaude() {
    try {
      await this.claude.models.retrieve(CLAUDE_MODEL);
      this.state.claude = { mode: 'ready' };
    } catch (err) {
      if (err instanceof Anthropic.APIConnectionError) this.state.claude = { mode: 'offline' };
      else if (err instanceof Anthropic.AuthenticationError) this.state.claude = { mode: 'invalid' };
      else if (!(err instanceof Anthropic.APIError)) this.state.claude = { mode: 'demo' }; // no credentials resolved
      else this.state.claude = { mode: 'ready' }; // authenticated; e.g. a permission quirk on the models endpoint
    }
  }
  async checkDeepSeek() {
    this.state.deepseek = await DS.checkDeepSeek(this.dsKey);
  }
  async checkOpenRouter() {
    this.state.openrouter = await OR.checkOpenRouter(this.orKey);
  }

  status() {
    return {
      claude: { ...this.state.claude, model: CLAUDE_MODEL, effort: CLAUDE_EFFORT },
      deepseek: { ...this.state.deepseek, model: this.dsCfg.model, thinking: this.dsCfg.thinking, effort: this.dsCfg.effort },
      openrouter: { ...this.state.openrouter, model: this.orCfg.model, thinking: this.orCfg.thinking, effort: this.orCfg.effort, pin: this.orCfg.pin, allowFallbacks: this.orCfg.allowFallbacks },
      models: DS.MODELS,
      orModels: OR.MODELS,
    };
  }

  modelOf(p) { return p === 'claude' ? CLAUDE_MODEL : p === 'openrouter' ? this.orCfg.model : this.dsCfg.model; }
  describe(p, err) { return p === 'claude' ? describeClaude(err) : p === 'openrouter' ? OR.describeOpenRouter(err) : DS.describeDeepSeek(err); }

  // native: the provider's append-only history for this chat (mutated). text: the raw user text (for demo).
  async run(p, native, hooks, text) {
    const mode = this.state[p].mode;
    const noClient = (p === 'deepseek' && !this.ds) || (p === 'openrouter' && !this.or);
    if (mode === 'demo' || noClient) return runDemo(p, text, native, hooks, this);
    try {
      if (p === 'claude') return await runClaude(this.claude, native, hooks);
      if (p === 'openrouter') return await OR.runOpenRouter(this.or, native, hooks, this.orCfg);
      return await DS.runDeepSeek(this.ds, native, hooks, this.dsCfg);
    } catch (err) {
      if (p === 'claude' && noClaudeCredentials(err)) {
        this.state.claude = { mode: 'demo' };
        hooks.onStatus && hooks.onStatus();
        return runDemo(p, text, native, hooks, this);
      }
      throw err;
    }
  }
}

// ---------- demo mode (no credentials) ----------
function parseReminder(text) {
  const m = text.match(/remind me in (\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)\b\s*(?:to|that|about)?\s*(.*)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase()[0];
  const delay = unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n;
  return { delay: Math.max(1, delay), message: (m[3] || 'Time is up!').replace(/[.!?]+$/, '') || 'Time is up!' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function stream(text, emit, signal, min = 22) {
  for (const p of text.match(/\s*\S+\s*/g) || []) {
    if (signal.aborted) break;
    await sleep(min + Math.random() * 36);
    emit(p);
  }
}

async function runDemo(p, text, native, hooks, agent) {
  const t = text.toLowerCase();
  const say = (s) => stream(s, hooks.onText, hooks.signal);
  const keyHint = p === 'deepseek' ? 'Add a DeepSeek key in **Settings (⌘,)**' : p === 'openrouter' ? 'Add an OpenRouter key in **Settings (⌘,)**' : 'Add a Claude key in **Settings (⌘,)**';
  if (p === 'deepseek' || p === 'openrouter') {
    await stream(`The user said "${text.slice(0, 60)}". I'm in demo mode, so I'll keep it simple and show what I can do.`, hooks.onReasoning, hooks.signal, 14);
  }
  let reply = '';
  const capture = async (s) => { reply += s; await say(s); };
  const r = parseReminder(text);
  if (r) {
    await hooks.onTool('set_reminder', { message: r.message, delay_seconds: r.delay });
    await capture(`Got it! I'll pop up in **${r.delay} s** with my cap and pointer to remind you: _${r.message}_. 🐾`);
  } else if (/\b(ls|list|files?|folder|terminal|shell|run|directory)\b|файл|папк|терминал/.test(t)) {
    await capture('Let me look around this folder. 🐾');
    const out = await hooks.onTool('run_command', { command: 'ls -la', timeout_seconds: 30 });
    if (hooks.signal.aborted) return { text: reply };
    if (/declined/.test(out.text)) {
      await capture('\n\nOkay, I won\'t run it. Tell me what you\'d like instead.');
    } else {
      const lines = out.text.split('--- output ---').pop().split('\n').filter((l) => /^[dl-][rwxsStT-]{9}/.test(l) && !/ \.\.?$/.test(l));
      await capture(`\n\nThis folder has **${lines.length}** entries (${lines.filter((l) => l[0] === 'd').length} folders). In demo mode I can only run this one example. ${keyHint} and I'll work in the terminal for real: run scripts, git, builds and tests, with you approving each command.`);
    }
  } else if (/^(hi|hey|hello|привет|yo)\b/.test(t)) {
    await capture("Mrrp, hi! I'm **May May**. Tell me what we're attacking today: a plan, a draft, some code in your terminal?");
  } else if (/plan|week|schedule|day/.test(t)) {
    await capture('Here\'s a pounce-ready plan:\n\n1. **Pick 3 targets** for the week — the ones that move the needle.\n2. **Block focus time** in the mornings, 90 minutes each.\n3. **Batch the small stuff** (email, errands) into one afternoon slot.\n4. **Friday review:** what landed, what slipped, what to drop.\n\nWant a nudge? Try _"remind me in 30 seconds to review"_.');
  } else {
    await capture(`I'm running in **demo mode**, so my answers are canned. ${keyHint} and I'll think for real.\n\nYou can still try: _"list the files here"_ (terminal) or _"remind me in 10 seconds to stretch"_.`);
  }
  if (reply) native.push(p === 'claude' ? { role: 'assistant', content: [{ type: 'text', text: reply }] } : p === 'deepseek' ? { role: 'assistant', content: reply, reasoning_content: '' } : { role: 'assistant', content: reply });
  return { text: reply };
}

module.exports = { Agent, PROVIDERS, CLAUDE_MODEL };
