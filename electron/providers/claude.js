// Claude via the official Anthropic SDK: streaming manual tool loop over an append-only history.
const Anthropic = require('@anthropic-ai/sdk').default;
const { SYSTEM, anthropicTools } = require('./shared');

const MODEL = 'claude-opus-5-5';
const EFFORT = 'low'; // chat route: quick replies; raise for heavier agent work

// After a mid-output fallback, model-internal blocks of the declined attempt must not be echoed back.
function echoable(content) {
  const last = content.map((b) => b.type).lastIndexOf('fallback');
  if (last < 0) return content;
  const drop = new Set(['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use']);
  return content.filter((b, i) => i > last || !drop.has(b.type));
}

// hooks: onText(delta), onTool(name, input) -> Promise<string>, onUsage(u), signal { aborted, onAbort(fn) }
async function runClaude(client, api, hooks) {
  let visible = '';
  let jsonRetries = 0;
  for (;;) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: EFFORT },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: anthropicTools(),
      messages: api,
    });
    hooks.signal.onAbort(() => stream.abort());
    stream.on('text', (delta) => { visible += delta; hooks.onText(delta); });

    let message;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      if (hooks.signal.aborted || err instanceof Anthropic.APIError || jsonRetries++ >= 2) {
        if (hooks.signal.aborted && visible) api.push({ role: 'assistant', content: [{ type: 'text', text: visible }] });
        throw err;
      }
      continue; // unparseable eager tool input: re-issue the turn
    }
    const u = message.usage || {};
    hooks.onUsage && hooks.onUsage({ input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0, cached: u.cache_read_input_tokens || 0 });

    if (message.stop_reason === 'refusal') {
      const text = message.content.filter((b) => b.type === 'text');
      if (text.length) api.push({ role: 'assistant', content: text });
      return { text: visible, refused: true };
    }
    api.push({ role: 'assistant', content: echoable(message.content) });
    if (message.stop_reason === 'pause_turn') continue;

    const uses = message.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) return { text: visible };
    if (message.stop_reason === 'max_tokens') throw new Error('A tool call was cut off (max_tokens).');

    const results = [];
    for (const use of uses) {
      const out = await hooks.onTool(use.name, use.input);
      results.push({ type: 'tool_result', tool_use_id: use.id, content: out.text, ...(out.error ? { is_error: true } : {}) });
    }
    api.push({ role: 'user', content: results });
    if (hooks.signal.aborted) throw new Anthropic.APIUserAbortError();
  }
}

function describeClaude(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Claude rejected the API key. Update it in Settings (⌘,).';
  if (err instanceof Anthropic.RateLimitError) return 'Claude is rate limited right now. Try again in a moment.';
  if (err instanceof Anthropic.APIConnectionError) return "Can't reach Claude. Check your connection.";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ''}: ${err.message}`.trim();
  return err && err.message ? err.message : String(err);
}

// true when the SDK could not find any credentials (no key, no env var, no `ant` profile)
const noClaudeCredentials = (err) => !(err instanceof Anthropic.APIError) && (err instanceof Anthropic.AnthropicError || /authentication method/i.test(String(err && err.message)));

module.exports = { Anthropic, MODEL, EFFORT, runClaude, describeClaude, noClaudeCredentials };
