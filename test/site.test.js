'use strict';

// The demo page in site/. Its signer runs the modules of src/ in a browser, with
// site/crypto-shim.js standing in for node:crypto. These tests build the page and
// compare that browser build with the Node implementation.

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const { echoServer } = require('./helpers');
const { parseArgs, resolveConfig, CHECKS } = require('../src/config');
const { buildRequest } = require('../src/request');
const { sign, ALGORITHMS, ENCODINGS } = require('../src/sign');

const run = promisify(execFile);
const ROOT = path.join(__dirname, '..');
const KEY = 'test_postback_key_not_secret';
const ENV = { MOONETIX_POSTBACK_KEY: KEY, POSTBACK_SECRET: KEY };
const MUTATIONS = [undefined, 'tampered-signature', 'tampered-reward', 'wrong-secret', 'missing-signature'];
const SIGNING = ALGORITHMS.filter((a) => a !== 'none');

let dir;
let site;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postback-site-test-'));
  await run(process.execPath, [path.join(ROOT, 'scripts', 'build-site.mjs'), '--out', dir], { cwd: ROOT });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  const load = (name) => import(pathToFileURL(path.join(dir, name)).href);
  site = {
    shim: await load('crypto-shim.js'),
    core: await load('core.js'),
    signer: await load('signer.js'),
    data: JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')),
    html: fs.readFileSync(path.join(dir, 'index.html'), 'utf8'),
  };
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const plain = (req) => ({ method: req.method, url: req.url, headers: req.headers, body: req.body, signature: req.signature });

// Splits a command as a POSIX shell would, for the subset the signer prints.
function shellWords(command) {
  const words = [];
  let word = null;
  const text = command.replace(/\\\n\s*/g, ' ');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      word = (word ?? '') + text.slice(i + 1, end);
      i = end;
    } else if (c === '\\') {
      word = (word ?? '') + text[++i];
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

test('the recorded run: the correct handler passes, the naive one fails what the README says', () => {
  const { data } = site;
  assert.deepEqual(data.checks.map((c) => c.id), CHECKS);
  for (const c of data.checks) {
    assert.equal(c.strict.label, 'PASS', c.id);
    assert.equal(c.naive.label, ['credit', 'reversal'].includes(c.id) ? 'PASS' : 'FAIL', c.id);
    assert.ok(c.sends && c.correct && c.cost, c.id);
    assert.ok(c.strict.requests.length > 0 && c.naive.requests.length > 0, c.id);
  }
  assert.deepEqual(data.handlers.strict.summary, { passed: 10, failed: 0, skipped: 0 });
  assert.deepEqual(data.handlers.naive.summary, { passed: 2, failed: 8, skipped: 0 });
  assert.equal(data.handlers.strict.exitCode, 0);
  assert.equal(data.handlers.naive.exitCode, 1);
  const race = data.checks.find((c) => c.id === 'race');
  assert.equal(race.naive.detail, 'balance changed by +500, expected +100');
  assert.equal(race.strict.requests[0].n, 5);
});

test('the page loads nothing from another origin and carries no unfilled placeholder', () => {
  const { html } = site;
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'/);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(html));
  for (const m of html.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) {
    assert.ok(!/^(?:[a-z]+:)?\/\//i.test(m[1]), `external resource ${m[1]}`);
    assert.ok(fs.existsSync(path.join(dir, m[1])), `missing ${m[1]}`);
  }
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), 'inline script');
  assert.ok(!/\sstyle="/.test(html) && !/<style/.test(html), 'inline style');
});

test('the header shows the recorded values and the page links to no sign-up', () => {
  const { html, data } = site;
  const fact = (name) => html.match(new RegExp(`<dt>${name}</dt><dd[^>]*>(.*?)</dd>`))?.[1].replace(/<[^>]+>/g, '');
  assert.equal(fact('Checks'), `${CHECKS.length}, each run on both handlers`);
  assert.equal(fact('Correct handler'), `${data.handlers.strict.summary.passed} of ${CHECKS.length} passed, exit code ${data.handlers.strict.exitCode}`);
  assert.equal(fact('Naive handler'), `${data.handlers.naive.summary.failed} of ${CHECKS.length} failed, exit code ${data.handlers.naive.exitCode}`);
  assert.equal(fact('Run recorded'), `${data.built.date}, version ${data.version} on Node ${data.built.node}`);
  assert.equal(fact('Commit'), data.built.commit || 'local build');
  assert.ok(!/register|sign up free/i.test(html), 'sign-up link');
  assert.match(html, /<p class="maintainer">Maintained by <a href="https:\/\/moonetix\.com">Moonetix<\/a>, an affiliate network\.<\/p>/);
});

test('the commands in the "Run it" section are the ones in the README', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const blocks = [...site.html.matchAll(/<pre class="code" id="run-[a-z0-9-]+"[^>]*>([\s\S]*?)<\/pre>/g)].map((m) => unescape(m[1]));
  assert.ok(blocks.length >= 7, `found ${blocks.length} snippets`);
  for (const block of blocks) assert.ok(readme.includes(block), `not in README.md:\n${block}`);
});

test('crypto shim: every digest equals node:crypto', async () => {
  const { createHash, createHmac, settle, md5 } = site.shim;
  const inputs = ['', 'a', 'abc', 'test_tx:test_user:100:1', 'zażółć gęślą jaźń', '\u{1D11E} and é', ...[55, 56, 57, 63, 64, 65, 119, 120, 121, 128, 1000].map((n) => 'x'.repeat(n))];
  const keys = ['k', KEY, 'clé secrète', 'k'.repeat(64), 'k'.repeat(65), 'k'.repeat(200)];
  for (const input of inputs) {
    assert.equal(Buffer.from(md5(new TextEncoder().encode(input))).toString('hex'), crypto.createHash('md5').update(input, 'utf8').digest('hex'));
    for (const algo of ['md5', 'sha1', 'sha256']) {
      for (const encoding of ['hex', 'base64']) {
        const got = await settle(() => createHash(algo).update(input, 'utf8').digest().toString(encoding));
        assert.equal(got.value, crypto.createHash(algo).update(input, 'utf8').digest(encoding), `${algo} ${encoding} of ${input.length} chars`);
        assert.deepEqual(got.digests, [{ algo, input, key: null }]);
      }
    }
    for (const algo of ['sha1', 'sha256']) {
      for (const key of keys) {
        const got = await settle(() => createHmac(algo, key).update(input, 'utf8').digest().toString('hex'));
        assert.equal(got.value, crypto.createHmac(algo, key).update(input, 'utf8').digest('hex'), `hmac-${algo}, key of ${key.length} chars`);
      }
    }
  }
});

test('sign() in the browser build equals src/sign.js for every algorithm and encoding', async () => {
  assert.deepEqual(site.core.ALGORITHMS, ALGORITHMS);
  assert.deepEqual(site.core.ENCODINGS, ENCODINGS);
  for (const algo of SIGNING) {
    for (const encoding of ENCODINGS) {
      for (const input of ['test_1a2b3c:test_user:0.75:1', 'user id+ü/!*()', '']) {
        const got = await site.shim.settle(() => site.core.sign(algo, input, KEY, encoding));
        assert.equal(got.value, sign(algo, input, KEY, encoding), `${algo} ${encoding}`);
      }
    }
  }
});

async function compare(state, argv, label) {
  const { signer, core, shim } = site;
  const cfg = resolveConfig(parseArgs(argv), ENV);
  const out = await signer.build(state);

  const events = {
    credit: { tx: state.tx, eventId: state.eventId, kind: 'credit', timestamp: state.timestamp },
    reversal: { tx: state.tx, eventId: state.reversalEventId, kind: 'reversal', timestamp: state.timestamp },
  };
  for (const [name, event] of Object.entries(events)) {
    const want = buildRequest(cfg, event);
    assert.deepEqual(plain(out[name]), plain(want), `${label}: ${name}`);
    if (cfg.sign.algo === 'none') {
      assert.equal(out[name].signed, null, label);
    } else {
      assert.equal(sign(cfg.sign.algo, out[name].signed, cfg.secret, cfg.sign.encoding), want.signature, `${label}: signed string of the ${name}`);
    }
  }
  if (out.forged) {
    const want = buildRequest(cfg, { tx: state.forgedTx, eventId: state.forgedEventId, kind: 'credit', mutation: out.forged.id, timestamp: state.timestamp });
    assert.deepEqual(plain(out.forged), plain(want), `${label}: ${out.forged.id}`);
    assert.notDeepEqual(plain(out.forged), plain(buildRequest(cfg, { ...events.credit, tx: state.forgedTx, eventId: state.forgedEventId })), `${label}: the forged request differs from a valid one`);
  }

  // Every request the tool can send, built by the browser modules from the browser's own configuration.
  const browserCfg = core.resolveConfig(core.parseArgs(out.argv), ENV);
  for (const kind of ['credit', 'reversal']) {
    for (const mutation of MUTATIONS) {
      const event = { tx: 'tx_1', eventId: 'ev_1', kind, mutation, timestamp: 1767225600 };
      const got = await shim.settle(() => core.buildRequest(browserCfg, event));
      assert.deepEqual(plain(got.value), plain(buildRequest(cfg, event)), `${label}: ${kind} ${mutation ?? 'unchanged'}`);
    }
  }

  // The command the page prints leads the tool to the same configuration.
  const words = shellWords(out.command);
  const at = words.findIndex((w) => w === '@moonetix/postback-tester');
  assert.equal(words[at - 1], 'npx', label);
  const again = resolveConfig(parseArgs(words.slice(at + 1)), ENV);
  assert.deepEqual({ ...again, okBody: String(again.okBody) }, { ...cfg, okBody: String(cfg.okBody) }, `${label}: command line`);
  if (cfg.secret && (cfg.sign.algo.startsWith('hmac') || /secret/i.test(cfg.url + cfg.sign.input))) {
    assert.equal(words[0], `${cfg.preset.secretEnv[0]}=${KEY}`, label);
  }
  return out;
}

test('the signer builds the same requests as the tool for every preset and every README example', async () => {
  const { signer, data } = site;
  assert.deepEqual(Object.keys(signer.presets), ['moonetix', 'custom']);
  assert.ok(data.starts.some((s) => s.argv.includes('moonetix')));
  assert.ok(data.starts.length >= 5);
  for (const start of data.starts) {
    const state = { ...signer.stateFrom(null, start.argv), key: KEY };
    const out = await compare(state, start.argv, start.title);
    assert.ok(out.credit.curl.startsWith('curl -g -i '), start.title);
  }
});

test('the signer matches the tool for awkward values, every algorithm and every encoding', async () => {
  const { signer } = site;

  const moonetix = {
    ...signer.stateFrom('moonetix'),
    key: KEY,
    url: 'https://staging.example.com/pb?u={user_id}&tx={transaction_id}&e={event_id}&s={status}&st={state}&r={reward}&p={payout}&o={offer_name}&x={foo}&h={hash}',
    user: "user id+ü/!'()*",
    reward: '1.000005',
    payout: '0.123456789',
    balanceUrl: 'https://staging.example.com/test/balance?user={user_id}',
    balancePath: 'data.balance',
  };
  moonetix.values = moonetix.values.replace('offer_name=Moonetix test postback', 'offer_name=Café & "Quotes" = 100%');
  const out = await compare(moonetix, signer.toArgv(moonetix), 'moonetix, awkward values');
  assert.match(out.credit.url, /&r=1\.00001&/);
  assert.match(out.credit.url, /&x=\{foo\}&/);
  assert.match(out.command, /^MOONETIX_POSTBACK_KEY=test_postback_key_not_secret npx @moonetix\/postback-tester --preset moonetix \\\n/);

  for (const algo of SIGNING) {
    for (const encoding of ENCODINGS) {
      const state = {
        ...signer.stateFrom('custom'),
        key: KEY,
        url: 'https://staging.example.com/cb?uid=[USER_ID]&oid={transaction_id}&amount={amount}&st={status}&ts={timestamp}&sig={signature}',
        algo,
        encoding,
        input: algo.startsWith('hmac') ? '{user_id}|{transaction_id}|{amount}|{status}|{timestamp}' : '{user_id}{amount}{transaction_id}{secret}',
        header: encoding === 'base64' ? 'X-Signature' : '',
        user: "o'brien & co",
        reward: '12.5',
        creditStatus: 'approved',
        reversalStatus: 'rejected',
        reversalReward: 'negative',
        okBody: '^OK$',
      };
      state.values += '\namount={reward}';
      await compare(state, signer.toArgv(state), `custom ${algo} ${encoding}`);
    }
  }

  const post = {
    ...signer.stateFrom('custom'),
    key: KEY,
    url: 'https://staging.example.com/hooks/rewards',
    method: 'POST',
    bodyType: 'json',
    body: '{"user":"{user_id}","tx":"{transaction_id}","reward":{reward},"status":{status}}',
    algo: 'hmac-sha256',
    input: '{body}',
    header: 'X-Signature',
    user: 'quote"and\\slash',
  };
  const posted = await compare(post, signer.toArgv(post), 'custom POST, signed body');
  assert.equal(posted.credit.signed, posted.credit.body);
  assert.match(posted.credit.curl, /^curl -g -i -X POST https:\/\/staging\.example\.com\/hooks\/rewards \\\n {2}-A postback-tester\/1\.0 \\\n {2}-H 'X-Signature: [0-9a-f]{64}' \\\n {2}-H 'Content-Type: application\/json' \\\n {2}--data-raw '/);
});

test('the signer reports what the tool would report', async () => {
  const { signer } = site;
  const base = { ...signer.stateFrom(null, site.data.starts[0].argv), key: KEY };
  await assert.rejects(signer.build({ ...base, key: '' }), /Enter a test key/);
  await assert.rejects(signer.build({ ...base, url: '' }), /Missing the postback URL template/);
  await assert.rejects(signer.build({ ...base, url: 'ftp://example.com/{hash}' }), /must start with http/);
  await assert.rejects(signer.build({ ...base, reward: 'ten' }), /Not a number: ten/);
  await assert.rejects(signer.build({ ...base, values: `${base.values}\nfoo=1` }), /Moonetix has no settable macro \{foo\}/);
  await assert.rejects(signer.build({ ...base, values: 'broken line' }), /line 1: write name=value/);
  await assert.rejects(signer.build({ ...signer.stateFrom('custom'), url: 'https://example.com/?s={sig}', algo: 'sha256', input: '' }), /--sign needs --sign-input/);

  const unsigned = await signer.build({ ...signer.stateFrom('custom'), url: 'https://example.com/pb?u={user_id}&r={reward}' });
  assert.equal(unsigned.forged, null);
  assert.equal(unsigned.credit.signature, null);
  assert.match(unsigned.notes.join(), /anyone who knows the URL can credit rewards/);
  assert.ok(!unsigned.command.includes('POSTBACK_SECRET'));

  const partly = await signer.build({ ...signer.stateFrom('custom'), key: KEY, url: 'https://example.com/pb?u={user_id}&r={reward}&s={sig}', algo: 'hmac-sha256', input: '{user_id}' });
  assert.equal(partly.forged.id, 'tampered-signature');
  assert.deepEqual(partly.notes, ['the reward is not part of the signature']);
  assert.deepEqual(partly.sentAs, ['{sig}']);

  const unsent = await signer.build({ ...signer.stateFrom('custom'), key: KEY, url: 'https://example.com/pb?u={user_id}&r={reward}', algo: 'hmac-sha256', input: '{user_id}{reward}' });
  assert.match(unsent.notes[0], /^the signature is computed but never sent/);
  const header = await signer.build({ ...signer.stateFrom('custom'), key: KEY, url: 'https://example.com/pb?u={user_id}&r={reward}', algo: 'hmac-sha256', input: '{user_id}{reward}', header: 'X-Sig' });
  assert.deepEqual(header.sentAs, ['the X-Sig header']);
  assert.deepEqual(header.notes, []);
});

test('the curl commands of the signer drive the example server like the tool does', async (t) => {
  try {
    execFileSync('curl', ['--version'], { stdio: 'ignore' });
  } catch {
    t.skip('curl is not installed');
    return;
  }
  const { signer } = site;
  const srv = await echoServer({ MOONETIX_POSTBACK_KEY: KEY });
  try {
    const state = {
      ...signer.stateFrom('moonetix'),
      key: KEY,
      url: `${srv.url}/postback?user={user_id}&tx={transaction_id}&status={status}&reward={reward}&hash={hash}`,
      user: "o'brien +1",
      reward: '0.75',
    };
    const out = await signer.build(state);
    const send = async (command) => (await run('sh', ['-c', `${command} -s`])).stdout;
    const balance = async () => JSON.parse((await run('curl', ['-s', `${srv.url}/balance?user=${encodeURIComponent(state.user)}`])).stdout).balance;

    assert.match(await send(out.credit.curl), /^HTTP\/1\.1 200 [\s\S]*\r\n\r\ncredited$/);
    assert.equal(await balance(), 0.75);
    assert.match(await send(out.credit.curl), /^HTTP\/1\.1 200 [\s\S]*\r\n\r\nduplicate$/);
    assert.equal(await balance(), 0.75);
    assert.match(await send(out.reversal.curl), /^HTTP\/1\.1 200 [\s\S]*\r\n\r\nreversed$/);
    assert.equal(await balance(), 0);
    assert.equal(out.forged.id, 'tampered-reward');
    assert.match(await send(out.forged.curl), /^HTTP\/1\.1 403 [\s\S]*\r\n\r\ninvalid hash$/);
    assert.equal(await balance(), 0);
    assert.match(srv.log(), /GET \/postback\?user=o%27brien%20%2B1&tx=test_[0-9a-f]{12}&status=1&reward=0\.75&hash=[0-9a-f]{64} -> 200 credited/);
  } finally {
    srv.stop();
  }
});
