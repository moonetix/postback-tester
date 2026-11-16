// Stands in for node:crypto when the modules in src/ run in a browser.
// SHA-1, SHA-256 and both HMACs go through WebCrypto, MD5 is computed here
// because WebCrypto does not offer it.
//
// WebCrypto answers asynchronously and src/sign.js is synchronous. A digest
// that is not known yet throws Pending; settle() waits for it and calls the
// function again, so the code in src/ stays as it is.

const WEB_NAMES = { sha1: 'SHA-1', sha256: 'SHA-256' };
const MAX_KNOWN = 400;
const encoder = new TextEncoder();
const known = new Map();
let log = null;

export class Pending extends Error {
  constructor(promise) {
    super('digest not ready');
    this.name = 'Pending';
    this.promise = promise;
  }
}

function toHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function toBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function digestOf(bytes) {
  return {
    toString(encoding) {
      if (encoding === 'hex') return toHex(bytes);
      if (encoding === 'base64') return toBase64(bytes);
      throw new Error(`Unsupported digest encoding: ${encoding}`);
    },
  };
}

const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(bytes) {
  const size = bytes.length;
  const padded = new Uint8Array((((size + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[size] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (size * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(size / 0x20000000), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let offset = 0; offset < padded.length; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const x = (a + f + MD5_K[i] + view.getUint32(offset + g * 4, true)) | 0;
      const s = MD5_SHIFTS[(i >> 4) * 4 + (i % 4)];
      a = d;
      d = c;
      c = b;
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((word, i) => outView.setUint32(i * 4, word, true));
  return out;
}

function subtle() {
  const api = globalThis.crypto && globalThis.crypto.subtle;
  if (!api) throw new Error('This page needs WebCrypto, which browsers only offer over HTTPS or on localhost.');
  return api;
}

async function webDigest(algo, key, input) {
  const name = WEB_NAMES[algo];
  if (key === null) return new Uint8Array(await subtle().digest(name, encoder.encode(input)));
  const imported = await subtle().importKey('raw', encoder.encode(key), { name: 'HMAC', hash: name }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', imported, encoder.encode(input)));
}

function hasher(algo, key) {
  if (algo !== 'md5' && !WEB_NAMES[algo]) throw new Error(`Unsupported hash: ${algo}`);
  if (key !== null && algo === 'md5') throw new Error('Unsupported HMAC: md5');
  let input = '';
  return {
    update(chunk) {
      input += String(chunk);
      return this;
    },
    digest() {
      if (log) log.push({ algo: key === null ? algo : `hmac-${algo}`, input, key });
      if (algo === 'md5') return digestOf(md5(encoder.encode(input)));
      const id = JSON.stringify([algo, key, input]);
      const entry = known.get(id);
      if (entry instanceof Uint8Array) return digestOf(entry);
      if (entry) throw new Pending(entry);
      if (known.size >= MAX_KNOWN) known.clear();
      const promise = webDigest(algo, key, input).then((bytes) => {
        known.set(id, bytes);
      });
      known.set(id, promise);
      throw new Pending(promise);
    },
  };
}

export function createHash(algo) {
  return hasher(algo, null);
}

export function createHmac(algo, key) {
  return hasher(algo, String(key));
}

export function randomBytes(size) {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return digestOf(bytes);
}

// Runs fn until every digest it asks for is known. Returns its value and the
// digests it computed on the final pass: algorithm, exact input, key.
export async function settle(fn) {
  for (;;) {
    log = [];
    try {
      const value = fn();
      return { value, digests: log };
    } catch (err) {
      if (!(err instanceof Pending)) throw err;
      await err.promise;
    } finally {
      log = null;
    }
  }
}
