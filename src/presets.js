'use strict';

const crypto = require('node:crypto');
const { moonetixAmount } = require('./amount');

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');

// Mirrors a Moonetix postback exactly: the documented macros and nothing else,
// values URL-encoded like PHP rawurlencode(), unknown macros left in place,
// amounts with at most five decimals, HMAC-SHA256 over tx:user:reward:status.
// Defaults are those of "Send a test postback" in the Moonetix dashboard.
const moonetix = {
  id: 'moonetix',
  method: 'GET',
  userAgent: 'Moonetix-Postback/1.0',
  headers: { Accept: '*/*' },
  syntax: { brackets: false, ignoreCase: false },
  sign: { algo: 'hmac-sha256', input: '{transaction_id}:{user_id}:{reward}:{status}', encoding: 'hex', header: null },
  signatureMacros: ['hash'],
  statuses: { credit: '1', reversal: '2' },
  states: { 1: 'credited', 2: 'reversed' },
  reversalReward: 'same',
  formatAmount: moonetixAmount,
  secretEnv: ['MOONETIX_POSTBACK_KEY', 'POSTBACK_SECRET'],
  macros: [
    'user_id', 'transaction_id', 'event_id', 'status', 'state', 'reward', 'currency', 'payout',
    'offer_id', 'offer_name', 'offer_type', 'country', 'device', 'ip',
    'sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'integration', 'app_id', 'hash',
  ],
  defaults: () => ({
    user_id: 'test_user',
    reward: '100',
    payout: '1',
    currency: 'Coins',
    offer_id: '0',
    offer_name: 'Moonetix test postback',
    offer_type: 'offer',
    country: 'US',
    device: 'desktop',
    ip: '203.0.113.10',
    sub1: 'test_sub1',
    sub2: 'test_sub2',
    sub3: 'test_sub3',
    sub4: 'test_sub4',
    sub5: 'test_sub5',
    integration: 'offerwall',
    app_id: process.env.MOONETIX_APP_ID || 'demoapp0000000000000001',
  }),
  newTransactionId: () => `test_${hex(6)}`,
  newEventId: () => `test_${hex(6)}`,
  locked: ['method', 'sign', 'statuses', 'reversalReward', 'body', 'bodyType', 'headers'],
};

// Any other network. Macros may be written {name} or [NAME]. Nothing is
// signed until --sign is given.
const custom = {
  id: 'custom',
  method: 'GET',
  userAgent: 'postback-tester/1.0',
  headers: {},
  syntax: { brackets: true, ignoreCase: true },
  sign: { algo: 'none', input: null, encoding: 'hex', header: null },
  signatureMacros: ['signature', 'hash', 'sig'],
  statuses: { credit: '1', reversal: '2' },
  states: {},
  reversalReward: 'same',
  formatAmount: (v) => String(v),
  secretEnv: ['POSTBACK_SECRET'],
  macros: null,
  defaults: () => ({
    user_id: 'test_user',
    reward: '100',
    payout: '1',
    currency: 'Coins',
    offer_id: '0',
    offer_name: 'Test offer',
    country: 'US',
    ip: '203.0.113.10',
  }),
  newTransactionId: () => `pbt_${hex(8)}`,
  newEventId: () => `evt_${hex(8)}`,
  locked: [],
};

module.exports = { presets: { moonetix, custom } };
