'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { moonetixAmount } = require('../src/amount');
const { fill, macrosIn, rawurlencode } = require('../src/template');
const { sign, tamper } = require('../src/sign');
const { splitArgs, argsFromEnv } = require('../src/action');

test('formats amounts like Moonetix', () => {
  const cases = {
    150: '150', '150.00': '150', 0.75: '0.75', 1.23456: '1.23456', 1.000005: '1.00001', 0.0000049: '0', 0.000005: '0.00001',
    2.675: '2.675', 1.234565: '1.23457', '123456789.123455': '123456789.12346', 1e-7: '0', 99999.999995: '100000',
    1e20: '100000000000000000000', '-0.000001': '0', 0: '0', '10.10': '10.1',
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(moonetixAmount(input), want, input);
  assert.throws(() => moonetixAmount('abc'), /Not a number/);
  assert.throws(() => moonetixAmount(''), /Not a number/);
});

test('rawurlencode matches PHP', () => {
  assert.equal(rawurlencode("a!b*c(d)e~f g'h"), 'a%21b%2Ac%28d%29e~f%20g%27h');
  assert.equal(rawurlencode('Bigo Live & "Friends"'), 'Bigo%20Live%20%26%20%22Friends%22');
  assert.equal(rawurlencode('ü'), '%C3%BC');
});

test('fills braces, brackets and leaves unknown macros alone', () => {
  const v = { user_id: 'a b', reward: '1' };
  assert.equal(fill('u={user_id}&x={nope}&y=[user_id]', v), 'u=a%20b&x={nope}&y=[user_id]');
  assert.equal(fill('u=[USER_ID]&r={Reward}', v, { brackets: true, ignoreCase: true }), 'u=a%20b&r=1');
  assert.equal(fill('{"u":"{user_id}"}', { user_id: 'x"y' }, { encode: 'json' }), '{"u":"x\\"y"}');
  assert.equal(fill('{{user_id}}', v), '{a%20b}');
  assert.deepEqual([...macrosIn('{a}[B]{c', { brackets: true, ignoreCase: true })], ['a', 'b']);
});

test('signature algorithms match published test vectors', () => {
  assert.equal(sign('md5', 'abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(sign('sha1', 'abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(sign('sha256', 'abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  // RFC 2202 and RFC 4231, test case 2
  assert.equal(sign('hmac-sha1', 'what do ya want for nothing?', 'Jefe'), 'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79');
  assert.equal(sign('hmac-sha256', 'what do ya want for nothing?', 'Jefe'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  assert.equal(sign('sha256', 'abc', null, 'HEX'), 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD');
  assert.equal(sign('md5', 'abc', null, 'base64'), 'kAFQmDzST7DWlj99KOF/cg==');
  assert.throws(() => sign('hmac-sha256', 'x', ''), /needs a secret/);
  assert.throws(() => sign('crc32', 'x'), /Unknown/);
});

test('tamper keeps length and alphabet', () => {
  for (const s of ['abc0', 'abcf', 'ABCF', 'xyz9', 'kAFQmDzST7DWlj99KOF/cg==', 'aZ']) {
    const t = tamper(s);
    assert.notEqual(t, s);
    assert.equal(t.length, s.length);
  }
  assert.match(tamper('00ff'), /^[0-9a-f]+$/);
});

test('action splits extra args like a shell and reads inputs from env', () => {
  assert.deepEqual(splitArgs(`--reward 0.75 --set "offer_name=Big Game" --ok-body '^OK$' a\\ b`), ['--reward', '0.75', '--set', 'offer_name=Big Game', '--ok-body', '^OK$', 'a b']);
  assert.deepEqual(splitArgs(`--set x=""`), ['--set', 'x=']);
  assert.throws(() => splitArgs('"open'), /Unclosed/);
  assert.deepEqual(argsFromEnv({ PT_URL: 'https://x.test/{user_id}', PT_PRESET: 'moonetix', PT_ARGS: '--json', GITHUB_STEP_SUMMARY: '/tmp/s', PT_SUMMARY: 'true' }),
    ['https://x.test/{user_id}', '--preset', 'moonetix', '--json', '--summary', '/tmp/s']);
  assert.ok(!argsFromEnv({ PT_URL: 'u', GITHUB_STEP_SUMMARY: '/tmp/s', PT_SUMMARY: 'false' }).includes('--summary'));
});
