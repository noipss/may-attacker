// Tests for electron/skills.js. Run: node scripts/test-skills.js
const assert = require('assert');
const sk = require('../electron/skills');

const seed = sk.seed();
assert.ok(seed.length >= 3 && seed.every((s) => s.id && s.name && s.prompt), 'seed shape');
assert.strictEqual(new Set(seed.map((s) => s.id)).size, seed.length, 'unique ids');

// validate
assert.ok(!sk.validate({ name: '', prompt: 'x' }).ok, 'empty name rejected');
assert.ok(!sk.validate({ name: 'n', prompt: '' }).ok, 'empty prompt rejected');
assert.ok(!sk.validate({ name: 'n'.repeat(61), prompt: 'x' }).ok, 'long name rejected');
const v = sk.validate({ name: '  Deploy  it ', prompt: ' do the thing ', provider: 'bogus' });
assert.ok(v.ok && v.value.name === 'Deploy it' && v.value.provider === '' && v.value.prompt === 'do the thing', 'normalised');

// upsert: add then update by id (no duplicate), bad input preserves list
let list = [];
let r = sk.upsert(list, { name: 'A', prompt: 'pa' });
assert.ok(r.ok && r.list.length === 1);
const aid = r.value.id;
r = sk.upsert(r.list, { id: aid, name: 'A2', prompt: 'pa2', provider: 'openrouter' });
assert.ok(r.ok && r.list.length === 1 && r.list[0].name === 'A2' && r.list[0].provider === 'openrouter', 'update in place');
assert.ok(!sk.upsert(r.list, { name: '', prompt: '' }).ok, 'bad upsert');

// match + filter
const m = sk.match(seed, '/explain some extra words');
assert.ok(m && m.rest === 'some extra words', 'rest parsed');
assert.ok(m.candidates.some((s) => /explain/i.test(s.name)), 'candidate found');
assert.ok(sk.match(seed, 'no slash') === null, 'non-skill line');
const exact = sk.upsert(seed, { name: 'go', prompt: 'g' });
assert.strictEqual(sk.match(exact.list, '/go now').skill.name, 'go', 'exact slug match');
assert.strictEqual(sk.filter(seed, '').length, seed.length, 'empty filter = all');

console.log('skills OK');
