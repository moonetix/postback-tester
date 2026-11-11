'use strict';

const crypto = require('node:crypto');

const ALGORITHMS = ['none', 'md5', 'sha1', 'sha256', 'hmac-sha1', 'hmac-sha256'];
const ENCODINGS = ['hex', 'HEX', 'base64'];

function sign(algo, input, secret, encoding = 'hex') {
  if (!ENCODINGS.includes(encoding)) throw new Error(`Unknown signature encoding: ${encoding}`);
  let digest;
  if (algo === 'md5' || algo === 'sha1' || algo === 'sha256') {
    digest = crypto.createHash(algo).update(input, 'utf8').digest();
  } else if (algo === 'hmac-sha1' || algo === 'hmac-sha256') {
    if (!secret) throw new Error(`${algo} needs a secret`);
    digest = crypto.createHmac(algo.slice(5), secret).update(input, 'utf8').digest();
  } else {
    throw new Error(`Unknown signature algorithm: ${algo}`);
  }
  if (encoding === 'base64') return digest.toString('base64');
  const hex = digest.toString('hex');
  return encoding === 'HEX' ? hex.toUpperCase() : hex;
}

// Changes one character so the signature keeps its length and alphabet but no longer matches.
function tamper(signature) {
  if (!signature) return 'x';
  const last = signature[signature.length - 1];
  const swap = { 0: '1', 9: '8', a: 'b', f: 'e', z: 'y', A: 'B', F: 'E', Z: 'Y', '=': 'A', '/': '+', '+': '/' };
  const next = swap[last] || String.fromCharCode(last.charCodeAt(0) + 1);
  return signature.slice(0, -1) + next;
}

module.exports = { sign, tamper, ALGORITHMS, ENCODINGS };
