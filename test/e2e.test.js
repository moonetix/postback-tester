'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, echoServer } = require('./helpers');

const KEY = 'test_postback_key_not_secret';
const MOONETIX_URL = '/postback?user={user_id}&tx={transaction_id}&event={event_id}&status={status}&reward={reward}&payout={payout}&hash={hash}';

test('a correct Moonetix handler passes every check', async () => {
  const srv = await echoServer({ MOONETIX_POSTBACK_KEY: KEY });
  try {
    const r = await run([srv.url + MOONETIX_URL, '--preset', 'moonetix', '--reward', '0.75', '--balance-url', srv.url + '/balance?user={user_id}', '--balance-path', 'balance'], { MOONETIX_POSTBACK_KEY: KEY });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /10 passed, 0 failed, 0 skipped/);
    assert.match(r.out, /PASS {2}Credit .* accepted, balance \+0\.75/);
    assert.ok(!r.out.includes(KEY), 'secret never printed');
  } finally {
    srv.stop();
  }
});

test('a naive handler fails duplicates, tampering and the race', async () => {
  const srv = await echoServer({ MODE: 'naive' });
  try {
    const r = await run([srv.url + MOONETIX_URL, '--preset', 'moonetix', '--balance-url', srv.url + '/balance?user={user_id}', '--balance-path', 'balance', '--json'], { MOONETIX_POSTBACK_KEY: KEY });
    assert.equal(r.code, 1);
    const report = JSON.parse(r.out);
    const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.equal(by.credit.pass, true);
    for (const id of ['duplicate', 'duplicate-reversal', 'unknown-reversal', 'tampered-signature', 'tampered-reward', 'wrong-secret', 'missing-signature', 'race']) {
      assert.equal(by[id].pass, false, id);
    }
    assert.match(by['tampered-signature'].notes.join(), /accepted with 200, expected a rejection/);
    assert.match(by.race.notes.join(), /balance changed by \+500, expected \+100/);
    assert.equal(by.race.requests.filter((q) => !q.cleanup).length, 5);
  } finally {
    srv.stop();
  }
});

// A small configurable server for the custom preset.
function customServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => handler(req, Buffer.concat(chunks).toString(), res));
    });
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, stop: () => server.close() }));
  });
}

test('custom: md5 of a concatenation with a secret, bracket macros, ok-body', async () => {
  const SECRET = 'net_secret';
  const seen = new Set();
  const srv = await customServer((req, body, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const want = crypto.createHash('md5').update(q.get('uid') + q.get('amount') + q.get('oid') + SECRET).digest('hex');
    if (q.get('sig') !== want) return res.end('0');
    if (q.get('st') !== 'approved' && q.get('st') !== 'rejected') return res.end('0');
    seen.add(q.get('oid'));
    res.end('1');
  });
  try {
    const r = await run([`${srv.url}/cb?uid=[USER_ID]&amount=[AMOUNT]&oid=[TX]&st=[STATUS]&sig=[SIGNATURE]`,
      '--set', 'amount={reward}', '--set', 'tx={transaction_id}',
      '--sign', 'md5', '--sign-input', '[USER_ID][AMOUNT][TX][SECRET]',
      '--credit-status', 'approved', '--reversal-status', 'rejected', '--ok-body', '^1$'], { POSTBACK_SECRET: SECRET });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /10 passed, 0 failed, 0 skipped/);
    assert.ok(seen.size > 0);
  } finally {
    srv.stop();
  }
});

test('custom: HMAC-SHA1 of a JSON body, signature in a header, POST', async () => {
  const SECRET = 'body_secret';
  const srv = await customServer((req, body, res) => {
    const want = crypto.createHmac('sha1', SECRET).update(body).digest('base64');
    const ok = req.method === 'POST' && req.headers['content-type'] === 'application/json' && req.headers['x-signature'] === want && JSON.parse(body).user === 'u"1';
    res.writeHead(ok ? 200 : 401).end();
  });
  try {
    const r = await run([`${srv.url}/hook`, '--method', 'POST', '--body-type', 'json', '--body', '{"user":"{user_id}","tx":"{transaction_id}","status":{status},"reward":{reward}}',
      '--user', 'u"1', '--sign', 'hmac-sha1', '--sign-input', '{body}', '--sign-encoding', 'base64', '--sign-header', 'X-Signature', '--race', '0'], { POSTBACK_SECRET: SECRET });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /9 passed, 0 failed, 0 skipped/);
  } finally {
    srv.stop();
  }
});

test('custom: unsigned postbacks are reported, slow answers and redirects fail', async () => {
  const srv = await customServer((req, body, res) => {
    if (req.url.startsWith('/slow')) return setTimeout(() => res.end('ok'), 300);
    if (req.url.startsWith('/moved')) return res.writeHead(301, { Location: '/elsewhere' }).end();
    res.end('ok');
  });
  try {
    let r = await run([`${srv.url}/open?u={user_id}`, '--checks', 'credit,tampered-signature,missing-signature']);
    assert.equal(r.code, 0);
    assert.match(r.out, /SKIP {2}Tampered signature/);
    assert.match(r.out, /Warning: postbacks are not signed, so anyone who knows the URL can credit rewards\./);

    r = await run([`${srv.url}/slow?u={user_id}`, '--checks', 'credit', '--slow', '100']);
    assert.equal(r.code, 1);
    assert.match(r.out, /slow: \d+ ms, limit 100 ms/);

    r = await run([`${srv.url}/slow?u={user_id}`, '--checks', 'credit', '--timeout', '100']);
    assert.equal(r.code, 1);
    assert.match(r.out, /no answer within 100 ms/);

    r = await run([`${srv.url}/moved?u={user_id}`, '--checks', 'credit']);
    assert.equal(r.code, 1);
    assert.match(r.out, /answered 301; redirects are not followed/);

    const closed = await new Promise((resolve) => {
      const s = http.createServer().listen(0, '127.0.0.1', () => {
        const port = s.address().port;
        s.close(() => resolve(port));
      });
    });
    r = await run([`http://127.0.0.1:${closed}/pb?u={user_id}`, '--checks', 'credit']);
    assert.equal(r.code, 1);
    assert.match(r.out, /ECONNREFUSED/);
  } finally {
    srv.stop();
  }
});

test('dry run, summary file, config file, usage errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbt-'));
  let r = await run(['https://staging.example.test/pb?u={user_id}&h={hash}&t={transaction_id}', '--preset', 'moonetix', '--dry-run', '--checks', 'credit'], { MOONETIX_POSTBACK_KEY: KEY });
  assert.equal(r.code, 0);
  assert.match(r.out, /SKIP {2}Credit .*dry run: not sent/);
  assert.match(r.out, /GET https:\/\/staging\.example\.test\/pb\?u=test_user&h=[0-9a-f]{64}&t=test_/);

  const cfgFile = path.join(dir, 'pt.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ url: 'https://x.test/pb?u={user_id}&s={signature}', sign: { algo: 'hmac-sha256', input: '{user_id}' }, secretEnv: 'MY_KEY', checks: ['credit'] }));
  const summary = path.join(dir, 'summary.md');
  r = await run(['--config', cfgFile, '--dry-run', '--summary', summary], { MY_KEY: 'k' });
  assert.equal(r.code, 0, r.err);
  assert.match(fs.readFileSync(summary, 'utf8'), /^### Postback test: passed\n/);

  fs.writeFileSync(cfgFile, JSON.stringify({ url: 'https://x.test/', secret: 'oops' }));
  r = await run(['--config', cfgFile]);
  assert.equal(r.code, 2);
  assert.match(r.err, /Do not put the secret in the config file/);

  for (const bad of [[], ['ftp://x.test/'], ['https://x.test/', '--secret', 'x'], ['https://x.test/', '--checks', 'nope'], ['https://x.test/', '--sign', 'md5'], ['https://x.test/', '--body', 'a=1'], ['https://x.test/', '--frobnicate']]) {
    r = await run(bad);
    assert.equal(r.code, 2, bad.join(' '));
    assert.match(r.err, /^postback-tester: /);
  }
  r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage: postback-tester/);
  r = await run(['--version']);
  assert.equal(r.out.trim(), require('../package.json').version);
});

test('bin script sets the exit code', async () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'postback-tester.js'), '--nope'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
