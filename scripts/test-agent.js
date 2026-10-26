// Offline tests of both provider loops: the real SDKs talk to a fake fetch that replays SSE streams.
// Run: node scripts/test-agent.js
const assert = require('assert');
const { Agent } = require('../electron/agent');
const terminal = require('../electron/terminal');
const { validate } = require('../electron/providers/shared');

const sseNamed = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const sseData = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
const okStream = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

function fakeFetch(replies, bodies) {
  return async (url, init) => {
    const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers;
    bodies.push({ url: String(url), headers, body: JSON.parse(init.body) });
    return okStream(replies.shift());
  };
}
const signal = () => ({ aborted: false, onAbort() {} });

// ---------- Claude ----------
function claudeMsg(id, content, stop) {
  return sseNamed([
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    ...content.flatMap((b, i) => (b.type === 'text'
      ? [{ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } },
        { type: 'content_block_stop', index: i }]
      : [{ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } },
        { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } },
        { type: 'content_block_stop', index: i }])),
    { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]);
}

async function testClaude() {
  const bodies = [];
  const replies = [
    claudeMsg('m1', [{ type: 'text', text: 'On it! ' }, { type: 'tool_use', id: 'tu1', name: 'set_reminder', input: { message: 'Stretch', delay_seconds: 10 } }], 'tool_use'),
    claudeMsg('m2', [{ type: 'text', text: 'Reminder set.' }], 'end_turn'),
  ];
  const agent = new Agent();
  agent.configure({ claudeKey: 'sk-test', clientOptions: { claude: { fetch: fakeFetch(replies, bodies), maxRetries: 0 } } });
  agent.state.claude = { mode: 'ready' };
  const api = [{ role: 'user', content: 'remind me in 10 seconds to stretch' }];
  let text = '';
  const calls = [];
  await agent.run('claude', api, {
    signal: signal(),
    onText: (d) => { text += d; },
    onTool: async (name, input) => { calls.push([name, input]); return { text: 'Reminder scheduled.' }; },
  });
  const b0 = bodies[0];
  assert.strictEqual(b0.body.model, 'claude-opus-5-5');
  assert.strictEqual(b0.body.fallbacks, 'default');
  assert.deepStrictEqual(b0.body.output_config, { effort: 'low' });
  assert.ok(/server-side-fallback-2026-07-01/.test(String(b0.headers['anthropic-beta'])));
  assert.deepStrictEqual(b0.body.tools.map((t) => t.name), ['run_command', 'read_file', 'write_file', 'edit_file', 'open_path', 'download_file', 'set_reminder']);
  assert.ok(b0.body.tools.every((t) => t.strict && t.eager_input_streaming));
  assert.deepStrictEqual(calls, [['set_reminder', { message: 'Stretch', delay_seconds: 10 }]]);
  assert.deepStrictEqual(api.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.strictEqual(api[2].content[0].tool_use_id, 'tu1');
  assert.strictEqual(text, 'On it! Reminder set.');
  console.log('claude loop OK');
}

// ---------- DeepSeek ----------
const dsChunk = (delta, finish = null, usage = null) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason: finish }], usage });
async function testDeepSeek() {
  const bodies = [];
  const replies = [
    sseData([
      dsChunk({ role: 'assistant', reasoning_content: 'Need to look ' }),
      dsChunk({ reasoning_content: 'at the folder.' }),
      dsChunk({ content: 'Checking… ' }),
      dsChunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'run_command', arguments: '{"command":"echo ' } }] }),
      dsChunk({ tool_calls: [{ index: 0, function: { arguments: 'hi from zsh","timeout_seconds":30}' } }] }),
      dsChunk({}, 'tool_calls'),
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 64, completion_tokens_details: { reasoning_tokens: 8 } } },
    ]),
    sseData([
      dsChunk({ role: 'assistant', reasoning_content: 'It printed hi.' }),
      dsChunk({ content: 'The shell says hi.' }),
      dsChunk({}, 'stop'),
    ]),
  ];
  const agent = new Agent();
  agent.configure({ deepseekKey: 'sk-ds', deepseek: { model: 'deepseek-flash', thinking: true, effort: 'high' }, clientOptions: { deepseek: { fetch: fakeFetch(replies, bodies), maxRetries: 0 } } });
  agent.state.deepseek = { mode: 'ready' };
  const msgs = [{ role: 'user', content: 'say hi from the shell' }];
  let text = '', reasoning = '', usage = null;
  await agent.run('deepseek', msgs, {
    signal: signal(),
    onText: (d) => { text += d; },
    onReasoning: (d) => { reasoning += d; },
    onUsage: (u) => { usage = usage || u; },
    onTool: async (name, input) => {
      const v = validate(name, input);
      assert.ok(v.ok);
      const r = await terminal.run({ command: v.value.command, cwd: process.cwd(), timeoutMs: 10000 }).promise;
      return { text: terminal.forModel(r) };
    },
  });
  const [b0, b1] = bodies;
  assert.ok(b0.url.startsWith('https://api.deepseek.com/chat/completions'), b0.url);
  assert.strictEqual(b0.headers.authorization || b0.headers.Authorization, 'Bearer sk-ds');
  assert.strictEqual(b0.body.model, 'deepseek-flash');
  assert.deepStrictEqual(b0.body.thinking, { type: 'enabled' });
  assert.strictEqual(b0.body.reasoning_effort, 'high');
  assert.ok(b0.body.stream && b0.body.stream_options.include_usage);
  assert.strictEqual(b0.body.messages[0].role, 'system');
  assert.deepStrictEqual(b0.body.tools.map((t) => t.function.name), ['run_command', 'read_file', 'write_file', 'edit_file', 'open_path', 'download_file', 'set_reminder']);
  assert.ok(!('tool_choice' in b0.body));
  // second request carries the full assistant message (reasoning + tool_calls) and the tool result
  const m = b1.body.messages;
  assert.deepStrictEqual(m.map((x) => x.role), ['system', 'user', 'assistant', 'tool']);
  assert.strictEqual(m[2].reasoning_content, 'Need to look at the folder.');
  assert.strictEqual(m[2].content, 'Checking… ');
  assert.strictEqual(m[2].tool_calls[0].function.arguments, '{"command":"echo hi from zsh","timeout_seconds":30}');
  assert.strictEqual(m[3].tool_call_id, 'call_1');
  assert.ok(/exit code 0/.test(m[3].content) && /hi from zsh/.test(m[3].content), m[3].content);
  assert.deepStrictEqual(msgs.map((x) => x.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.strictEqual(msgs[3].reasoning_content, 'It printed hi.');
  assert.strictEqual(text, 'Checking… The shell says hi.');
  assert.strictEqual(reasoning, 'Need to look at the folder.It printed hi.');
  assert.deepStrictEqual(usage, { input: 100, output: 20, cached: 64, reasoning: 8 });
  console.log('deepseek loop OK');
}

// ---------- OpenRouter ----------
const orChunk = (delta, finish = null, usage = null) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'deepseek/deepseek-v4-pro', choices: [{ index: 0, delta, finish_reason: finish }], usage });
async function testOpenRouter() {
  const bodies = [];
  const replies = [
    sseData([
      orChunk({ role: 'assistant', reasoning: 'Let me count ', reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'Let me count ' }] }),
      orChunk({ reasoning: 'the letters.', reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'the letters.' }] }),
      orChunk({ content: 'Checking… ' }),
      orChunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'run_command', arguments: '{"command":"echo ' } }] }),
      orChunk({ tool_calls: [{ index: 0, function: { arguments: 'hi","timeout_seconds":30}' } }] }),
      orChunk({}, 'tool_calls'),
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'deepseek/deepseek-v4-pro', choices: [], usage: { prompt_tokens: 50, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 6 }, cost: 0.0001 } },
    ]),
    sseData([
      orChunk({ role: 'assistant', reasoning: 'Done.', reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'Done.' }] }),
      orChunk({ content: 'It printed hi.' }),
      orChunk({}, 'stop'),
    ]),
  ];
  const agent = new Agent();
  agent.configure({ openrouterKey: 'sk-or', openrouter: { model: 'deepseek/deepseek-v4-pro', thinking: true, effort: 'high', pin: 'streamlake/fp8', allowFallbacks: false }, clientOptions: { openrouter: { fetch: fakeFetch(replies, bodies), maxRetries: 0 } } });
  agent.state.openrouter = { mode: 'ready' };
  const msgs = [{ role: 'user', content: "count the r's" }];
  let text = '', reasoning = '', usage = null;
  await agent.run('openrouter', msgs, {
    signal: signal(),
    onText: (d) => { text += d; },
    onReasoning: (d) => { reasoning += d; },
    onUsage: (u) => { usage = usage || u; },
    onTool: async (name, input) => {
      const v = validate(name, input);
      assert.ok(v.ok);
      const r = await terminal.run({ command: v.value.command, cwd: process.cwd(), timeoutMs: 10000 }).promise;
      return { text: terminal.forModel(r) };
    },
  });
  const [b0, b1] = bodies;
  assert.ok(b0.url.startsWith('https://openrouter.ai/api/v1/chat/completions'), b0.url);
  assert.strictEqual(b0.headers.authorization || b0.headers.Authorization, 'Bearer sk-or');
  assert.strictEqual(b0.body.model, 'deepseek/deepseek-v4-pro');
  assert.deepStrictEqual(b0.body.reasoning, { enabled: true, effort: 'high' });
  assert.deepStrictEqual(b0.body.provider, { only: ['streamlake/fp8'], allow_fallbacks: false });
  assert.ok(b0.body.stream && b0.body.stream_options.include_usage);
  assert.strictEqual(b0.body.messages[0].role, 'system');
  assert.deepStrictEqual(b0.body.tools.map((t) => t.function.name), ['run_command', 'read_file', 'write_file', 'edit_file', 'open_path', 'download_file', 'set_reminder']);
  // second request preserves reasoning_details (merged from deltas) + tool_calls + tool result
  const m = b1.body.messages;
  assert.deepStrictEqual(m.map((x) => x.role), ['system', 'user', 'assistant', 'tool']);
  assert.deepStrictEqual(m[2].reasoning_details, [{ type: 'reasoning.text', text: 'Let me count the letters.' }]);
  assert.strictEqual(m[2].tool_calls[0].function.arguments, '{"command":"echo hi","timeout_seconds":30}');
  assert.strictEqual(m[3].tool_call_id, 'call_1');
  assert.ok(/exit code 0/.test(m[3].content) && /hi/.test(m[3].content));
  assert.deepStrictEqual(msgs.map((x) => x.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.deepStrictEqual(msgs[3].reasoning_details, [{ type: 'reasoning.text', text: 'Done.' }]);
  assert.strictEqual(text, 'Checking… It printed hi.');
  assert.strictEqual(reasoning, 'Let me count the letters.Done.');
  assert.deepStrictEqual(usage, { input: 50, output: 12, cached: 20, reasoning: 6, cost: 0.0001 });
  console.log('openrouter loop OK');
}

// ---------- demo ----------
async function testDemo() {
  const agent = new Agent();
  agent.configure({});
  agent.state.deepseek = { mode: 'demo' };
  const msgs = [{ role: 'user', content: 'list the files here' }];
  let text = '', reasoning = '';
  const tools = [];
  await agent.run('deepseek', msgs, {
    signal: signal(),
    onText: (d) => { text += d; },
    onReasoning: (d) => { reasoning += d; },
    onTool: async (name, input) => { tools.push(name); return { text: 'exit code 0\ncwd: /x\n--- output ---\ntotal 8\ndrwxr-xr-x  4 me staff 128 Oct 19 10:00 .\ndrwxr-xr-x  9 me staff 288 Oct 19 10:00 ..\ndrwxr-xr-x  2 me staff  64 Oct 19 10:00 src\n-rw-r--r--  1 me staff  10 Oct 19 10:00 a.txt\n' }; },
  }, 'list the files here');
  assert.deepStrictEqual(tools, ['run_command']);
  assert.ok(reasoning.length > 10 && /\*\*2\*\* entries \(1 folders\)/.test(text) && text.includes('\n\nThis folder'), text);
  assert.strictEqual(msgs[1].role, 'assistant');
  console.log('demo OK');
}

// ---------- file & system tools ----------
const fs = require('fs');
const path = require('path');
const os = require('os');
const files = require('../electron/files');

function testFileTools() {
  // validation rejects bad input and normalizes good input
  assert.ok(!validate('read_file', {}).ok);
  assert.ok(!validate('write_file', { path: 'a.txt' }).ok);          // missing content
  assert.ok(!validate('edit_file', { path: 'a', old_string: '', new_string: 'x' }).ok); // empty old
  assert.ok(!validate('download_file', { url: 'ftp://x/y', dest: 'z' }).ok); // non-http
  assert.ok(validate('edit_file', { path: 'a', old_string: 'x', new_string: 'y' }).value.replace_all === false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'may-files-'));
  const abs = (p) => files.resolve(p, dir);

  // write → read round-trip
  let r = files.writeFile(abs('notes/todo.txt'), 'one\ntwo\nthree\n');
  assert.ok(r.ok && /Created/.test(r.output), r.output);
  r = files.readFile(abs('notes/todo.txt'));
  assert.ok(r.ok && /3 lines/.test(r.output) && /one\ntwo\nthree/.test(r.output), r.output);

  // edit: unique match replaces; ambiguous match is refused; replace_all works
  r = files.editFile(abs('notes/todo.txt'), 'two', 'TWO');
  assert.ok(r.ok && /1 replacement/.test(r.output), r.output);
  assert.strictEqual(fs.readFileSync(abs('notes/todo.txt'), 'utf8'), 'one\nTWO\nthree\n');
  files.writeFile(abs('dup.txt'), 'a a a');
  assert.ok(!files.editFile(abs('dup.txt'), 'a', 'b').ok);                 // 3 matches, no replace_all
  assert.ok(files.editFile(abs('dup.txt'), 'a', 'b', true).ok);           // replace_all
  assert.strictEqual(fs.readFileSync(abs('dup.txt'), 'utf8'), 'b b b');
  assert.ok(!files.editFile(abs('missing.txt'), 'x', 'y').ok);            // no such file
  assert.ok(!files.readFile(abs('missing.txt')).ok);

  // overwrite reports "Overwrote"; read a folder lists entries
  r = files.writeFile(abs('notes/todo.txt'), 'changed');
  assert.ok(/Overwrote/.test(r.output), r.output);
  r = files.readFile(abs('notes'));
  assert.ok(r.ok && /is a folder/.test(r.output) && /todo\.txt/.test(r.output), r.output);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('file tools OK');
}

(async () => {
  await testClaude();
  await testDeepSeek();
  await testOpenRouter();
  await testDemo();
  testFileTools();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
