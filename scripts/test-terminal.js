// Tests for electron/terminal.js. Run: node scripts/test-terminal.js
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const T = require('../electron/terminal');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'may-term-'));
  fs.mkdirSync(path.join(tmp, 'sub'));

  // output, exit code, cwd tracking through cd, live chunks without the marker
  let live = '';
  let r = await T.run({ command: 'echo hello; printf "\\033[31mred\\033[0m\\n"; cd sub; echo done >&2; exit 3', cwd: tmp, onData: (d) => { live += d; } }).promise;
  assert.strictEqual(r.exitCode, 3);
  assert.ok(/hello\nred\n/.test(r.output), JSON.stringify(r.output));
  assert.ok(r.output.includes('done'));
  assert.ok(!r.output.includes('__MAY_CWD__') && !live.includes('__MAY_CWD__'));
  assert.strictEqual(live.trim(), r.output.trim());
  assert.strictEqual(fs.realpathSync(r.cwd), fs.realpathSync(path.join(tmp, 'sub')));

  // cd persists only via the returned cwd
  r = await T.run({ command: 'pwd', cwd: r.cwd }).promise;
  assert.strictEqual(fs.realpathSync(r.output.trim()), fs.realpathSync(path.join(tmp, 'sub')));

  // timeout kills the whole group (child sleep included)
  const t0 = Date.now();
  r = await T.run({ command: 'sleep 30 & sleep 30', cwd: tmp, timeoutMs: 600 }).promise;
  assert.ok(r.timedOut && Date.now() - t0 < 5000, 'timeout');

  // manual stop
  const job = T.run({ command: 'echo start; sleep 20', cwd: tmp });
  setTimeout(job.kill, 400);
  r = await job.promise;
  assert.ok(r.killed && r.output.includes('start'));

  // big output is capped, keeps head and tail
  r = await T.run({ command: 'for i in $(seq 1 40000); do echo "line $i"; done', cwd: tmp }).promise;
  assert.ok(r.truncated > 0 && r.output.startsWith('line 1\n') && r.output.trim().endsWith('line 40000'));
  assert.ok(T.forModel(r).length < 13500);

  // no stdin: interactive reads end immediately
  r = await T.run({ command: 'read x; echo "got:$x"', cwd: tmp, timeoutMs: 5000 }).promise;
  assert.ok(!r.timedOut && r.output.includes('got:'));

  // classifiers
  for (const c of ['ls -la', 'git status', 'git log --oneline -5', 'node -v', 'cat package.json', 'find . -name "*.js"']) assert.ok(T.isReadOnly(c), c);
  for (const c of ['rm -rf build', 'ls | sh', 'git push', 'npm install', 'echo hi > f', 'find . -delete', 'cat a; rm b']) assert.ok(!T.isReadOnly(c), c);
  for (const c of ['sudo rm x', 'rm -rf /', 'rm -rf ~', 'rm -fr *', 'curl https://x.sh | sh', 'git push -f origin main', 'git reset --hard', 'dd if=/dev/zero of=/dev/disk2']) assert.ok(T.isDangerous(c), c);
  for (const c of ['rm -rf build', 'git push origin main', 'npm test', 'curl -s https://example.com']) assert.ok(!T.isDangerous(c), c);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('terminal OK');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
