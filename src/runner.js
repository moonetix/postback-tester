'use strict';

const { buildRequest } = require('./request');
const { fill, macrosIn } = require('./template');

const TITLES = {
  credit: 'Credit',
  duplicate: 'Duplicate credit (retry)',
  reversal: 'Reversal of the credit',
  'duplicate-reversal': 'Duplicate reversal',
  'unknown-reversal': 'Reversal of an unknown transaction',
  'tampered-signature': 'Tampered signature',
  'tampered-reward': 'Tampered reward',
  'wrong-secret': 'Signed with the wrong secret',
  'missing-signature': 'Missing signature',
  race: 'Same credit in parallel',
};

const BODY_LIMIT = 2000;

async function send(cfg, req) {
  const started = performance.now();
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body === null ? undefined : req.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const text = await res.text();
    const ms = Math.round(performance.now() - started);
    const ok2xx = res.status >= 200 && res.status < 300;
    const accepted = ok2xx && (!cfg.okBody || cfg.okBody.test(text));
    return { status: res.status, ms, response: text.slice(0, BODY_LIMIT), accepted, error: null };
  } catch (e) {
    const ms = Math.round(performance.now() - started);
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    const cause = e.cause && (e.cause.code || e.cause.message);
    return { status: null, ms, response: '', accepted: false, error: timedOut ? `no answer within ${cfg.timeoutMs} ms` : cause || e.message };
  }
}

function readPath(obj, p) {
  return p.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

async function readBalance(cfg) {
  const url = fill(cfg.balance.url, cfg.values, { ...cfg.syntax, encode: 'url' });
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': cfg.userAgent }, signal: AbortSignal.timeout(cfg.timeoutMs) });
  } catch (e) {
    throw new Error(`balance URL failed: ${(e.cause && e.cause.code) || e.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`balance URL answered ${res.status}`);
  let value;
  if (cfg.balance.path) {
    try {
      value = readPath(JSON.parse(text), cfg.balance.path);
    } catch {
      throw new Error('balance URL did not return JSON');
    }
  } else {
    const m = text.match(/-?\d+(?:\.\d+)?/);
    value = m ? m[0] : undefined;
  }
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) throw new Error(`no balance found in: ${text.slice(0, 120)}`);
  return n;
}

// Which tamper checks make sense for this signature setup.
function applicability(cfg) {
  const syntax = cfg.syntax;
  const templates = [cfg.url, cfg.body, ...Object.values(cfg.headers)].filter(Boolean);
  const staticSecret = templates.some((t) => macrosIn(t, syntax).has('secret'));
  const signed = cfg.sign.algo !== 'none';
  // A macro carries the reward if it is {reward} or a --set alias of it, such as amount={reward}.
  const norm = (k) => (syntax.ignoreCase ? k.toLowerCase() : k);
  const rewardNames = new Set(['reward']);
  for (const [k, v] of Object.entries(cfg.values)) if (macrosIn(String(v), syntax).has('reward')) rewardNames.add(norm(k));
  const carriesReward = (t) => [...macrosIn(t, syntax)].some((m) => rewardNames.has(m));
  const inSig = signed ? macrosIn(cfg.sign.input, syntax) : new Set();
  const rewardSigned = (signed && carriesReward(cfg.sign.input)) || (inSig.has('body') && cfg.body && carriesReward(cfg.body));
  const why = {};
  if (!signed && !staticSecret) {
    const msg = 'postbacks are not signed, so anyone who knows the URL can credit rewards';
    why['tampered-signature'] = msg;
    why['tampered-reward'] = msg;
    why['wrong-secret'] = msg;
    why['missing-signature'] = msg;
  } else if (!signed) {
    why['tampered-signature'] = 'only a static secret parameter, no signature';
    why['tampered-reward'] = 'the reward is not signed';
  } else if (!rewardSigned) {
    why['tampered-reward'] = 'the reward is not part of the signature';
  }
  return why;
}

async function runChecks(cfg, { onResult = () => {} } = {}) {
  const p = cfg.preset;
  const reward = p.formatAmount(cfg.values.reward);
  const rewardNum = Number(reward);
  const notApplicable = applicability(cfg);
  const results = [];

  const mainTx = p.newTransactionId();
  const credit = buildRequest(cfg, { tx: mainTx, eventId: p.newEventId(), kind: 'credit' });
  const reversal = buildRequest(cfg, { tx: mainTx, eventId: p.newEventId(), kind: 'reversal' });

  const plan = {
    credit: { requests: [credit], expect: 'accept', delta: rewardNum },
    duplicate: { requests: [credit], expect: 'accept', delta: 0 },
    reversal: { requests: [reversal], expect: 'accept', delta: -rewardNum },
    'duplicate-reversal': { requests: [reversal], expect: 'accept', delta: 0 },
    'unknown-reversal': { requests: () => [buildRequest(cfg, { tx: p.newTransactionId(), eventId: p.newEventId(), kind: 'reversal' })], expect: 'accept', delta: 0 },
  };
  for (const m of ['tampered-signature', 'tampered-reward', 'wrong-secret', 'missing-signature']) {
    plan[m] = { requests: () => [buildRequest(cfg, { tx: p.newTransactionId(), eventId: p.newEventId(), kind: 'credit', mutation: m })], expect: 'reject', delta: 0 };
  }
  plan.race = { race: true, expect: 'accept', delta: rewardNum };

  for (const id of cfg.checks) {
    const step = plan[id];
    const result = { id, title: TITLES[id], expect: step.expect, pass: false, skipped: false, notes: [], requests: [], balance: null };
    if (notApplicable[id]) {
      result.skipped = true;
      result.notes.push(`skipped: ${notApplicable[id]}`);
      results.push(result);
      onResult(result);
      continue;
    }

    let requests;
    let cleanup = null;
    if (step.race) {
      const tx = p.newTransactionId();
      const req = buildRequest(cfg, { tx, eventId: p.newEventId(), kind: 'credit' });
      requests = Array.from({ length: cfg.race }, () => req);
      cleanup = buildRequest(cfg, { tx, eventId: p.newEventId(), kind: 'reversal' });
    } else {
      requests = typeof step.requests === 'function' ? step.requests() : step.requests;
    }

    if (cfg.dryRun) {
      result.requests = requests.map((r) => ({ ...describe(r) }));
      result.skipped = true;
      result.notes.push('dry run: not sent');
      results.push(result);
      onResult(result);
      continue;
    }

    let before = null;
    if (cfg.balance) {
      try {
        before = await readBalance(cfg);
      } catch (e) {
        result.notes.push(e.message);
      }
    }

    const answers = step.race ? await Promise.all(requests.map((r) => send(cfg, r))) : [await send(cfg, requests[0])];
    result.requests = requests.map((r, i) => ({ ...describe(r), ...answers[i] }));

    let pass = true;
    for (const a of answers) {
      if (a.error) {
        pass = false;
        result.notes.push(a.error);
      } else if (step.expect === 'accept' && !a.accepted) {
        pass = false;
        result.notes.push(a.status >= 300 && a.status < 400 ? `answered ${a.status}; redirects are not followed` : `answered ${a.status}${cfg.okBody && a.status < 300 ? ' with a body that does not match --ok-body' : ''}, expected 2xx`);
      } else if (step.expect === 'reject' && a.accepted) {
        pass = false;
        result.notes.push(`accepted with ${a.status}, expected a rejection`);
      }
      if (a.ms > cfg.slowMs) {
        pass = false;
        result.notes.push(`slow: ${a.ms} ms, limit ${cfg.slowMs} ms`);
      }
    }

    if (cfg.balance && before !== null) {
      try {
        const after = await readBalance(cfg);
        const delta = round6(after - before);
        result.balance = { before, after, delta, expected: step.delta };
        if (Math.abs(delta - step.delta) > 1e-6) {
          pass = false;
          result.notes.push(`balance changed by ${fmt(delta)}, expected ${fmt(step.delta)}`);
        }
      } catch (e) {
        pass = false;
        result.notes.push(e.message);
      }
    }

    if (cleanup) {
      const c = await send(cfg, cleanup);
      result.requests.push({ ...describe(cleanup), ...c, cleanup: true });
      if (!c.accepted) result.notes.push(`cleanup reversal answered ${c.status || c.error}`);
    }

    result.pass = pass;
    results.push(result);
    onResult(result);
  }

  const summary = {
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
  };
  return { results, summary, warnings: Object.values(notApplicable).filter((v, i, a) => a.indexOf(v) === i && /anyone/.test(v)) };
}

function describe(req) {
  return { method: req.method, url: req.url, headers: req.headers, body: req.body };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function fmt(n) {
  return (n > 0 ? '+' : '') + String(round6(n));
}

module.exports = { runChecks, send, readBalance, applicability, TITLES };
