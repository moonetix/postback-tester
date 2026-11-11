'use strict';

// PHP rawurlencode(): RFC 3986, so ! ' ( ) * are encoded too.
// encodeURIComponent() leaves those five alone.
function rawurlencode(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

const ENCODERS = {
  url: rawurlencode,
  json: (v) => JSON.stringify(String(v)).slice(1, -1),
  none: (v) => String(v),
};

// Replaces {name} (and [name] when brackets is true) with values[name].
// Unknown macros are left as they are, which is also what Moonetix does.
// With ignoreCase, [USER_ID] and {user_id} are the same macro.
function fill(template, values, { encode = 'url', brackets = false, ignoreCase = false } = {}) {
  const enc = ENCODERS[encode];
  if (!enc) throw new Error(`Unknown encoding: ${encode}`);
  const lookup = new Map();
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue;
    lookup.set(ignoreCase ? k.toLowerCase() : k, v);
  }
  const re = brackets ? /\{([A-Za-z0-9_]+)\}|\[([A-Za-z0-9_]+)\]/g : /\{([A-Za-z0-9_]+)\}/g;
  return String(template).replace(re, (match, a, b) => {
    const name = a || b;
    const key = ignoreCase ? name.toLowerCase() : name;
    return lookup.has(key) ? enc(lookup.get(key)) : match;
  });
}

// Names of the macros a template uses, lower-cased when ignoreCase is set.
function macrosIn(template, { brackets = false, ignoreCase = false } = {}) {
  const re = brackets ? /\{([A-Za-z0-9_]+)\}|\[([A-Za-z0-9_]+)\]/g : /\{([A-Za-z0-9_]+)\}/g;
  const out = new Set();
  for (const m of String(template).matchAll(re)) out.add(ignoreCase ? (m[1] || m[2]).toLowerCase() : m[1] || m[2]);
  return out;
}

module.exports = { fill, macrosIn, rawurlencode };
