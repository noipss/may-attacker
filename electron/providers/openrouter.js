// OpenRouter via its OpenAI-compatible API (one key, many models/providers; RU-card-friendly billing).
// Reasoning is enabled with `reasoning:{enabled,effort}` and comes back as `reasoning` (text, for
// display) plus `reasoning_details` (structured). reasoning_details MUST be echoed back unmodified on
// every later request so the model can continue its chain of thought and tool calls stay valid — the
// history is append-only and stores it verbatim. A provider can be pinned with `provider:{only,...}`.
const OpenAI = require('openai').default;
const { SYSTEM, openaiTools } = require('./shared');

const BASE_URL = 'https://openrouter.ai/api/v1';
// Model ids are "vendor/model"; the pin is an OpenRouter provider slug (optionally "/variant").
const MODELS = [
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', note: 'strong reasoning · 1M ctx' },
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', note: 'fast & cheap · 1M ctx' },
];
const DEFAULTS = { model: 'deepseek/deepseek-v4-pro', thinking: true, effort: 'high', pin: 'streamlake/fp8', allowFallbacks: false, maxTokens: 16384 };
const MAX_STEPS = 40;
const EFFORTS = ['low', 'medium', 'high'];
const mapEffort = (e) => (EFFORTS.includes(e) ? e : e === 'max' ? 'high' : 'high');

function makeClient(apiKey, options = {}) {
  return new OpenAI({
    apiKey,
    baseURL: options.baseURL || BASE_URL,
    maxRetries: 2,
    timeout: 10 * 60 * 1000,
    // optional, used by OpenRouter for app ranking; harmless if ignored
    defaultHeaders: { 'HTTP-Referer': 'https://may-attacker.app', 'X-Title': 'May Attacker', ...(options.defaultHeaders || {}) },
    ...options,
  });
}

// Merge streamed reasoning_details deltas (each carries an `index`; string fields append).
const APPEND_FIELDS = new Set(['text', 'summary', 'data', 'signature']);
function mergeReasoning(acc, deltas) {
  let addedText = '';
  for (const d of deltas || []) {
    const i = typeof d.index === 'number' ? d.index : acc.length;
    const cur = acc[i] || (acc[i] = {});
    for (const [k, v] of Object.entries(d)) {
      if (k === 'index') continue;
      if (APPEND_FIELDS.has(k) && typeof v === 'string') {
        cur[k] = (typeof cur[k] === 'string' ? cur[k] : '') + v; // only these accumulate across chunks
        if (k === 'text' || k === 'summary') addedText += v;
      } else {
        cur[k] = v; // type, format, id: the API repeats these each chunk — overwrite, never concatenate
      }
    }
  }
  return addedText;
}
const cleanReasoning = (acc) => acc.filter(Boolean);

async function runOpenRouter(client, messages, hooks, cfg = DEFAULTS) {
  let visible = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    const ac = new AbortController();
    hooks.signal.onAbort(() => ac.abort());
    const body = {
      model: cfg.model,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
      tools: openaiTools(),
      max_tokens: Number.isInteger(cfg.maxTokens) && cfg.maxTokens > 0 ? cfg.maxTokens : DEFAULTS.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      reasoning: cfg.thinking ? { enabled: true, effort: mapEffort(cfg.effort) } : { enabled: false },
    };
    if (cfg.pin) body.provider = { only: [cfg.pin], allow_fallbacks: !!cfg.allowFallbacks };

    let content = '', finish = null, usage = null;
    const reasoningText = { shown: false };
    const details = [];
    const calls = [];
    try {
      const streamResp = await client.chat.completions.create(body, { signal: ac.signal });
      for await (const chunk of streamResp) {
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const d = choice.delta || {};
        if (typeof d.reasoning === 'string' && d.reasoning) { reasoningText.shown = true; hooks.onReasoning(d.reasoning); }
        if (d.reasoning_details) {
          const added = mergeReasoning(details, d.reasoning_details);
          // if the provider streams reasoning only inside details, surface it too
          if (added && !d.reasoning) { reasoningText.shown = true; hooks.onReasoning(added); }
        }
        if (d.content) { content += d.content; visible += d.content; hooks.onText(d.content); }
        for (const tc of d.tool_calls || []) {
          const c = calls[tc.index] || (calls[tc.index] = { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) c.id = tc.id;
          if (tc.function && tc.function.name) c.function.name += tc.function.name;
          if (tc.function && tc.function.arguments) c.function.arguments += tc.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (err) {
      if (hooks.signal.aborted && (content || details.length)) {
        const a = { role: 'assistant', content };
        if (cleanReasoning(details).length) a.reasoning_details = cleanReasoning(details);
        messages.push(a);
      }
      throw err;
    }
    if (usage && hooks.onUsage) {
      const cached = (usage.prompt_tokens_details || {}).cached_tokens || 0;
      const reasoning = (usage.completion_tokens_details || {}).reasoning_tokens || 0;
      hooks.onUsage({ input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0, cached, reasoning, cost: usage.cost || 0 });
    }

    const toolCalls = calls.filter(Boolean);
    const assistant = { role: 'assistant', content };
    const rd = cleanReasoning(details);
    if (rd.length) assistant.reasoning_details = rd;      // preserve unmodified for the next request
    if (toolCalls.length) assistant.tool_calls = toolCalls;
    messages.push(assistant);

    if (finish === 'content_filter') return { text: visible, filtered: true };
    if (finish === 'error') throw new Error('OpenRouter returned an error for this request.');
    if (finish === 'length' && toolCalls.length) throw new Error('A tool call was cut off (max_tokens).');
    if (!toolCalls.length) return { text: visible, finish };

    for (const call of toolCalls) {
      let args;
      try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) { args = null; }
      const out = args ? await hooks.onTool(call.function.name, args) : { text: 'Error: the tool arguments were not valid JSON. Send the call again with valid JSON.', error: true };
      messages.push({ role: 'tool', tool_call_id: call.id, content: out.text });
    }
    if (hooks.signal.aborted) throw new OpenAI.APIUserAbortError();
  }
  throw new Error(`Stopped after ${MAX_STEPS} tool steps in one turn.`);
}

function describeOpenRouter(err) {
  if (err instanceof OpenAI.AuthenticationError) return 'OpenRouter rejected the API key. Update it in Settings (⌘,).';
  if (err instanceof OpenAI.RateLimitError) return 'OpenRouter rate limit reached. Try again in a moment.';
  if (err instanceof OpenAI.APIConnectionError) return "Can't reach OpenRouter. Check your connection.";
  if (err instanceof OpenAI.APIError) {
    if (err.status === 402) return 'OpenRouter credits are empty. Top up at openrouter.ai/credits.';
    if (err.status === 400 || err.status === 404) return `OpenRouter rejected the request (${err.status}): ${err.message}. Check the model id and the pinned provider.`;
    if (err.status >= 500) return `OpenRouter servers are busy (${err.status}). Try again in a moment.`;
    return `OpenRouter API error ${err.status ?? ''}: ${err.message}`.trim();
  }
  return err && err.message ? err.message : String(err);
}

// Free check: validates the key and reads remaining credit.
async function checkOpenRouter(apiKey, fetchImpl = fetch) {
  if (!apiKey) return { mode: 'demo' };
  try {
    const res = await fetchImpl(`${BASE_URL}/key`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
    if (res.status === 401) return { mode: 'invalid' };
    if (!res.ok) return { mode: 'ready', balance: null };
    const j = await res.json();
    const d = j.data || {};
    let balance = null;
    if (typeof d.limit === 'number') balance = `$${Math.max(0, d.limit - (d.usage || 0)).toFixed(2)} left`;
    else if (typeof d.usage === 'number') balance = `$${d.usage.toFixed(2)} used`;
    return { mode: 'ready', balance, available: d.limit_remaining !== 0 };
  } catch (_) {
    return { mode: 'offline' };
  }
}

module.exports = { OpenAI, BASE_URL, MODELS, DEFAULTS, EFFORTS, makeClient, runOpenRouter, describeOpenRouter, checkOpenRouter, mergeReasoning };
