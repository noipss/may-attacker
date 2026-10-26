// DeepSeek via its OpenAI-compatible Chat Completions API, using the official `openai` SDK.
// Thinking mode + tools: the whole assistant message — including reasoning_content — must be
// sent back on every later request, so history is append-only and stores it verbatim.
const OpenAI = require('openai').default;
const { SYSTEM, openaiTools } = require('./shared');

const BASE_URL = 'https://api.deepseek.com';
const MODELS = [
  { id: 'deepseek-flash', label: 'DeepSeek Flash', note: 'V4.1 Flash · fast & cheap · 1M ctx' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', note: 'stronger reasoning · 1M ctx' },
  { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', note: 'legacy alias → V4.1 Flash' },
];
const DEFAULTS = { model: 'deepseek-flash', thinking: true, effort: 'high' };
const MAX_STEPS = 40;

function makeClient(apiKey, options = {}) {
  return new OpenAI({ apiKey, baseURL: options.baseURL || BASE_URL, maxRetries: 2, timeout: 10 * 60 * 1000, ...options });
}

// hooks: onText(delta), onReasoning(delta), onTool(name, input) -> Promise<{text, error?}>, onUsage(u), signal
async function runDeepSeek(client, messages, hooks, cfg = DEFAULTS) {
  let visible = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    const ac = new AbortController();
    hooks.signal.onAbort(() => ac.abort());
    const body = {
      model: cfg.model,
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
      tools: openaiTools(),
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: cfg.thinking ? 'enabled' : 'disabled' },
    };
    if (cfg.thinking) body.reasoning_effort = cfg.effort;

    let content = '', reasoning = '', finish = null, usage = null;
    const calls = [];
    try {
      const stream = await client.chat.completions.create(body, { signal: ac.signal });
      for await (const chunk of stream) {
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const d = choice.delta || {};
        if (d.reasoning_content) { reasoning += d.reasoning_content; hooks.onReasoning(d.reasoning_content); }
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
      // keep what was said so the history stays a faithful, append-only transcript
      if (hooks.signal.aborted && (content || reasoning)) messages.push({ role: 'assistant', content, reasoning_content: reasoning });
      throw err;
    }
    if (usage && hooks.onUsage) {
      hooks.onUsage({ input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0, cached: usage.prompt_cache_hit_tokens || 0, reasoning: (usage.completion_tokens_details || {}).reasoning_tokens || 0 });
    }

    const toolCalls = calls.filter(Boolean);
    const assistant = { role: 'assistant', content, reasoning_content: reasoning };
    if (toolCalls.length) assistant.tool_calls = toolCalls;
    messages.push(assistant);

    if (finish === 'insufficient_system_resource') throw new Error('DeepSeek is short on capacity right now. Try again in a moment.');
    if (finish === 'content_filter') return { text: visible, filtered: true };
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

function describeDeepSeek(err) {
  if (err instanceof OpenAI.AuthenticationError) return 'DeepSeek rejected the API key. Update it in Settings (⌘,).';
  if (err instanceof OpenAI.RateLimitError) return 'DeepSeek rate limit reached. Try again in a moment.';
  if (err instanceof OpenAI.APIConnectionError) return "Can't reach DeepSeek. Check your connection.";
  if (err instanceof OpenAI.APIError) {
    if (err.status === 402) return 'DeepSeek balance is empty. Top up at platform.deepseek.com.';
    if (err.status === 422 || err.status === 400) return `DeepSeek rejected the request (${err.status}): ${err.message}`;
    if (err.status >= 500) return `DeepSeek servers are busy (${err.status}). Try again in a moment.`;
    return `DeepSeek API error ${err.status ?? ''}: ${err.message}`.trim();
  }
  return err && err.message ? err.message : String(err);
}

// Free check: validates the key and reads the balance.
async function checkDeepSeek(apiKey, fetchImpl = fetch) {
  if (!apiKey) return { mode: 'demo' };
  try {
    const res = await fetchImpl(`${BASE_URL}/user/balance`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
    if (res.status === 401) return { mode: 'invalid' };
    if (!res.ok) return { mode: 'ready', balance: null };
    const j = await res.json();
    const b = (j.balance_infos || [])[0];
    return { mode: 'ready', balance: b ? `${b.total_balance} ${b.currency}` : null, available: j.is_available !== false };
  } catch (_) {
    return { mode: 'offline' };
  }
}

module.exports = { OpenAI, BASE_URL, MODELS, DEFAULTS, makeClient, runDeepSeek, describeDeepSeek, checkDeepSeek };
