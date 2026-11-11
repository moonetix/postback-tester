'use strict';

// The moonetix preset must produce exactly what Moonetix sends. The fixture
// holds postback URLs built by the Moonetix postback code itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { parseArgs, resolveConfig } = require('../src/config');
const { buildRequest } = require('../src/request');
const vectors = require('./fixtures/moonetix-vectors.json');
const { run } = require('./helpers');

const env = { MOONETIX_POSTBACK_KEY: vectors.postback_key };

function configFor(values) {
  const args = [vectors.template, '--preset', 'moonetix'];
  for (const [k, v] of Object.entries({ ...vectors.values, ...values })) args.push('--set', `${k}=${v}`);
  return resolveConfig(parseArgs(args), env);
}

test(`preset output equals the Moonetix postback byte for byte (${vectors.cases.length} cases)`, () => {
  for (const c of vectors.cases) {
    const cfg = configFor({ user_id: c.user_id, reward: c.reward });
    const req = buildRequest(cfg, { tx: c.transaction_id, eventId: vectors.values.event_id, kind: c.status === 2 ? 'reversal' : 'credit' });
    assert.equal(req.url, c.postback, `${c.transaction_id} ${c.user_id} ${c.reward} ${c.status}`);
  }
});

test('hash follows the documented formula', () => {
  const cfg = configFor({ user_id: '42', reward: '150' });
  const req = buildRequest(cfg, { tx: 'tx_1001', eventId: 'e1', kind: 'credit' });
  const expected = crypto.createHmac('sha256', vectors.postback_key).update('tx_1001:42:150:1').digest('hex');
  assert.equal(req.signature, expected);
  assert.equal(req.method, 'GET');
  assert.equal(req.body, null);
  assert.deepEqual(req.headers, { 'User-Agent': 'Moonetix-Postback/1.0', Accept: '*/*' });
});

test('defaults match a dashboard test postback', () => {
  const cfg = resolveConfig(parseArgs(['https://x.test/pb?tx={transaction_id}&o={offer_id}&n={offer_name}&s1={sub1}&e={event_id}', '--preset', 'moonetix']), env);
  const req = buildRequest(cfg, { tx: cfg.preset.newTransactionId(), eventId: cfg.preset.newEventId(), kind: 'credit' });
  assert.match(req.url, /tx=test_[0-9a-f]{12}&o=0&n=Moonetix%20test%20postback&s1=test_sub1&e=test_[0-9a-f]{12}$/);
});

test('the preset cannot be bent into something Moonetix does not send', async () => {
  const url = 'https://x.test/pb?h={hash}';
  for (const extra of [['--sign', 'md5'], ['--method', 'POST'], ['--header', 'X-A: 1'], ['--credit-status', 'ok'], ['--set', 'timestamp=1'], ['--set', 'hash=abc']]) {
    const r = await run([url, '--preset', 'moonetix', ...extra], env);
    assert.equal(r.code, 2, extra.join(' '));
  }
  const r = await run([url, '--preset', 'moonetix'], {});
  assert.equal(r.code, 2);
  assert.match(r.err, /MOONETIX_POSTBACK_KEY/);
});
