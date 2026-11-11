#!/usr/bin/env node
'use strict';

// A small local server to try postback-tester against.
//
//   MOONETIX_POSTBACK_KEY=test_postback_key_not_secret node examples/echo-server.js
//
// GET /postback  Moonetix-style handler. Expects
//                ?user={user_id}&tx={transaction_id}&status={status}&reward={reward}&hash={hash}
// GET /balance   ?user=<id>  returns {"user": "...", "balance": 123.45}
// anything else  echoes the request back as JSON
//
// MODE=strict (default) verifies the hash and credits each transaction once.
// MODE=naive skips the hash and credits every request, to show what failing checks look like.

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const MODE = process.env.MODE || 'strict';
const SECRET = process.env.MOONETIX_POSTBACK_KEY || process.env.POSTBACK_SECRET || '';
const DELAY_MS = Number(process.env.DELAY_MS || 0);

if (MODE === 'strict' && !SECRET) {
  console.error('Set MOONETIX_POSTBACK_KEY (or POSTBACK_SECRET), or run with MODE=naive.');
  process.exit(2);
}

// Amounts are kept in millionths so that 0.75 + 1.23456 adds up exactly.
const balances = new Map();
const transactions = new Map();

function micros(reward) {
  if (!/^\d+(\.\d{1,6})?$/.test(reward)) return null;
  const [i, f = ''] = reward.split('.');
  return Number(i) * 1e6 + Number((f + '000000').slice(0, 6));
}

function addBalance(user, delta) {
  balances.set(user, (balances.get(user) || 0) + delta);
}

function validHash(q) {
  const expected = crypto.createHmac('sha256', SECRET)
    .update(`${q.get('tx') ?? ''}:${q.get('user') ?? ''}:${q.get('reward') ?? ''}:${q.get('status') ?? ''}`)
    .digest('hex');
  const given = Buffer.from(q.get('hash') || '');
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

function postback(q) {
  const tx = q.get('tx') || '';
  const user = q.get('user') || '';
  const status = q.get('status');
  const amount = micros(q.get('reward') || '');

  if (MODE === 'naive') {
    if (amount !== null) addBalance(user, status === '2' ? -amount : amount);
    return [200, 'OK'];
  }
  if (!q.get('hash')) return [400, 'missing hash'];
  if (!validHash(q)) return [403, 'invalid hash'];
  if (!tx || !user || amount === null || (status !== '1' && status !== '2')) return [400, 'bad request'];

  // Same rules as a production handler: one credit per transaction, a reversal
  // takes back exactly what was credited, and a reversal of an unknown
  // transaction is remembered so a late credit is never paid.
  const known = transactions.get(tx);
  if (status === '1') {
    if (known) return [200, 'duplicate'];
    transactions.set(tx, { user, amount, state: 'credited' });
    addBalance(user, amount);
    return [200, 'credited'];
  }
  if (!known) {
    transactions.set(tx, { user, amount: 0, state: 'reversed' });
    return [200, 'ignored'];
  }
  if (known.state === 'reversed') return [200, 'duplicate'];
  known.state = 'reversed';
  addBalance(known.user, -known.amount);
  return [200, 'reversed'];
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const body = Buffer.concat(chunks).toString('utf8');
    let status = 200;
    let type = 'text/plain';
    let out;
    if (url.pathname === '/postback') {
      [status, out] = postback(url.searchParams);
    } else if (url.pathname === '/balance') {
      const user = url.searchParams.get('user') || '';
      type = 'application/json';
      out = JSON.stringify({ user, balance: (balances.get(user) || 0) / 1e6 });
    } else {
      type = 'application/json';
      out = JSON.stringify({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body }, null, 2);
    }
    if (url.pathname !== '/balance') console.log(`${req.method} ${req.url} -> ${status} ${type === 'text/plain' ? out : ''}`);
    setTimeout(() => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(out);
    }, DELAY_MS);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Listening on http://${HOST}:${server.address().port} (mode ${MODE})`);
});

module.exports = server;
