'use strict';

const { fill, macrosIn } = require('./template');
const { sign, tamper } = require('./sign');

// Builds one postback request.
// event: { tx, eventId, kind: 'credit' | 'reversal', mutation, reward }
// mutation: null, 'tampered-signature', 'tampered-reward', 'wrong-secret' or 'missing-signature'
function buildRequest(cfg, event) {
  const { preset, syntax } = cfg;
  const status = event.kind === 'reversal' ? cfg.statuses.reversal : cfg.statuses.credit;
  let reward = preset.formatAmount(event.reward !== undefined ? event.reward : cfg.values.reward);
  if (event.kind === 'reversal' && cfg.reversalReward === 'negative' && !reward.startsWith('-') && Number(reward) !== 0) {
    reward = '-' + reward;
  }

  const values = { ...cfg.values };
  values.transaction_id = event.tx;
  values.event_id = event.eventId;
  values.status = status;
  values.reward = reward;
  if ('payout' in values) values.payout = preset.formatAmount(values.payout);
  if (preset.states[status]) values.state = preset.states[status];
  if (!preset.macros) {
    values.timestamp = String(event.timestamp || Math.floor(Date.now() / 1000));
    if (cfg.secret) values.secret = cfg.secret;
  }

  // --set values may refer to other macros, e.g. uid={user_id}.
  const expandAliases = () => {
    if (preset.macros) return;
    const base = { ...values };
    for (const [k, v] of Object.entries(cfg.values)) {
      if (!['transaction_id', 'event_id', 'status', 'reward'].includes(k)) values[k] = fill(v, base, { ...syntax, encode: 'none' });
    }
  };
  expandAliases();

  const secret = event.mutation === 'wrong-secret' ? `${cfg.secret}_wrong` : cfg.secret;
  const signValues = { ...values, ...(values.secret !== undefined ? { secret } : {}) };
  if (event.mutation === 'wrong-secret' && values.secret !== undefined) values.secret = secret;

  let signature = null;
  let body = null;
  if (cfg.sign.algo !== 'none') {
    const signsBody = macrosIn(cfg.sign.input, syntax).has('body');
    if (signsBody) {
      body = buildBody(cfg, values);
      signValues.body = body;
    }
    signature = sign(cfg.sign.algo, fill(cfg.sign.input, signValues, { ...syntax, encode: 'none' }), secret, cfg.sign.encoding);
    if (event.mutation === 'tampered-signature') signature = tamper(signature);
    if (event.mutation === 'missing-signature') signature = '';
  }
  if (event.mutation === 'tampered-reward') {
    // Signed for the real reward, sent with a larger one.
    values.reward = preset.formatAmount(String(Number(reward.replace(/^-/, '')) * 10 + 1));
    if (reward.startsWith('-')) values.reward = '-' + values.reward;
    expandAliases();
  }
  if (signature !== null) for (const m of preset.signatureMacros) values[m] = signature;
  if (event.mutation === 'missing-signature' && cfg.sign.algo === 'none' && values.secret !== undefined) values.secret = '';

  const url = fill(cfg.url, values, { ...syntax, encode: 'url' });
  if (body === null && cfg.body !== undefined) body = buildBody(cfg, values);
  else if (body !== null && event.mutation === 'tampered-reward') body = buildBody(cfg, values);

  const headers = { 'User-Agent': cfg.userAgent };
  for (const [k, v] of Object.entries(cfg.headers)) headers[k] = fill(v, values, { ...syntax, encode: 'none' });
  if (cfg.sign.header && signature) headers[cfg.sign.header] = signature;
  if (body !== null && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = cfg.bodyType === 'json' ? 'application/json' : cfg.bodyType === 'form' ? 'application/x-www-form-urlencoded' : 'text/plain';
  }

  return { method: cfg.method, url, headers, body, values, signature };
}

function buildBody(cfg, values) {
  const encode = cfg.bodyType === 'json' ? 'json' : cfg.bodyType === 'form' ? 'url' : 'none';
  const v = { ...values };
  delete v.body;
  return fill(cfg.body, v, { ...cfg.syntax, encode });
}

module.exports = { buildRequest };
