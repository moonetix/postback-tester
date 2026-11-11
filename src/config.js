'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { presets } = require('./presets');
const { ALGORITHMS, ENCODINGS } = require('./sign');
const { macrosIn } = require('./template');

const CHECKS = [
  'credit',
  'duplicate',
  'reversal',
  'duplicate-reversal',
  'unknown-reversal',
  'tampered-signature',
  'tampered-reward',
  'wrong-secret',
  'missing-signature',
  'race',
];

class UsageError extends Error {}

const HELP = `Usage: postback-tester <url-template> [options]

Sends signed test postbacks to your endpoint and checks how it answers.

Presets
  --preset moonetix          Exact Moonetix postbacks (HMAC-SHA256, macros, encoding)
  --preset custom            Any other network (default). Configure with the options below.

Request
  --method GET|POST          HTTP method (default GET)
  --body <template>          Request body for POST, with macros
  --body-type form|json|raw  How macro values are escaped in the body (default form)
  --header "Name: value"     Extra header, may contain macros. Repeatable.

Signature (custom preset)
  --sign <algo>              none, md5, sha1, sha256, hmac-sha1, hmac-sha256
  --sign-input <template>    What is signed, e.g. "{transaction_id}{user_id}{reward}{secret}"
  --sign-encoding <enc>      hex (default), HEX or base64
  --sign-header <name>       Also send the signature in this header
  The signature is available as {signature}, {hash} and {sig}.
  The secret comes from POSTBACK_SECRET (moonetix: MOONETIX_POSTBACK_KEY), or --secret-env NAME.

Values
  --user <id>                User ID (default test_user)
  --reward <amount>          Reward in your currency (default 100)
  --payout <amount>          Payout in USD (default 1)
  --set name=value           Any macro value. Values may use other macros: --set uid={user_id}
  --credit-status <v>        Status value of a credit (default 1)
  --reversal-status <v>      Status value of a reversal (default 2)
  --reversal-reward same|negative
                             Reward sign on reversals (default same)

Expectations
  --ok-body <regex>          A 2xx answer counts as accepted only if the body matches
  --balance-url <template>   URL that returns the user's balance; enables balance checks
  --balance-path <a.b>       JSON path to the balance in that answer
  --timeout <ms>             Abort a request after this long (default 10000)
  --slow <ms>                Fail a check slower than this (default 6000)

Checks
  --checks <list>            Run only these: ${CHECKS.join(', ')}
  --skip <list>              Skip these
  --race <n>                 Parallel copies in the race check (default 5, 0 skips it)

Output
  --config <file.json>       Read options from a JSON file; command line options win
  --json                     Print a JSON report
  --summary <file>           Append a Markdown report to a file (e.g. $GITHUB_STEP_SUMMARY)
  --verbose                  Print every request and answer
  --dry-run                  Print the requests without sending them
  --version, --help

Exit codes: 0 every check passed, 1 a check failed, 2 usage or configuration error.
`;

function splitList(v) {
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const o = { headers: {}, values: {}, sign: {}, statuses: {}, balance: {} };
  const need = (i, flag) => {
    if (i >= argv.length) throw new UsageError(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      case '--preset': o.preset = need(++i, a); break;
      case '--config': o.config = need(++i, a); break;
      case '--method': o.method = need(++i, a).toUpperCase(); break;
      case '--body': o.body = need(++i, a); break;
      case '--body-type': o.bodyType = need(++i, a); break;
      case '--header': {
        const h = need(++i, a);
        const c = h.indexOf(':');
        if (c < 1) throw new UsageError(`--header needs "Name: value", got ${h}`);
        o.headers[h.slice(0, c).trim()] = h.slice(c + 1).trim();
        break;
      }
      case '--sign': o.sign.algo = need(++i, a); break;
      case '--sign-input': o.sign.input = need(++i, a); break;
      case '--sign-encoding': o.sign.encoding = need(++i, a); break;
      case '--sign-header': o.sign.header = need(++i, a); break;
      case '--secret': throw new UsageError('Pass the secret in an environment variable (POSTBACK_SECRET, or name one with --secret-env), not on the command line.');
      case '--secret-env': o.secretEnv = need(++i, a); break;
      case '--user': o.values.user_id = need(++i, a); break;
      case '--reward': o.values.reward = need(++i, a); break;
      case '--payout': o.values.payout = need(++i, a); break;
      case '--currency': o.values.currency = need(++i, a); break;
      case '--set': {
        const s = need(++i, a);
        const eq = s.indexOf('=');
        if (eq < 1) throw new UsageError(`--set needs name=value, got ${s}`);
        o.values[s.slice(0, eq).trim()] = s.slice(eq + 1);
        break;
      }
      case '--credit-status': o.statuses.credit = need(++i, a); break;
      case '--reversal-status': o.statuses.reversal = need(++i, a); break;
      case '--reversal-reward': o.reversalReward = need(++i, a); break;
      case '--ok-body': o.okBody = need(++i, a); break;
      case '--balance-url': o.balance.url = need(++i, a); break;
      case '--balance-path': o.balance.path = need(++i, a); break;
      case '--timeout': o.timeoutMs = Number(need(++i, a)); break;
      case '--slow': o.slowMs = Number(need(++i, a)); break;
      case '--checks': o.checks = splitList(need(++i, a)); break;
      case '--skip': o.skip = splitList(need(++i, a)); break;
      case '--race': o.race = Number(need(++i, a)); break;
      case '--json': o.json = true; break;
      case '--summary': o.summary = need(++i, a); break;
      case '--verbose': o.verbose = true; break;
      case '--dry-run': o.dryRun = true; break;
      default:
        if (a.startsWith('-') && a !== '-') throw new UsageError(`Unknown option: ${a}`);
        if (o.url) throw new UsageError(`Only one URL template, got a second one: ${a}`);
        o.url = a;
    }
  }
  return o;
}

function readConfigFile(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (e) {
    throw new UsageError(`Cannot read config ${file}: ${e.message}`);
  }
  if ('secret' in raw) throw new UsageError('Do not put the secret in the config file. Use an environment variable and "secretEnv".');
  return raw;
}

// Merges preset < config file < command line into one validated object.
function resolveConfig(cli, env = process.env) {
  const file = cli.config ? readConfigFile(cli.config) : {};
  const presetId = cli.preset || file.preset || 'custom';
  const preset = presets[presetId];
  if (!preset) throw new UsageError(`Unknown preset: ${presetId}. Use moonetix or custom.`);

  const pick = (key) => (cli[key] !== undefined ? cli[key] : file[key]);
  const merged = {
    url: pick('url'),
    method: pick('method'),
    body: pick('body'),
    bodyType: pick('bodyType'),
    headers: { ...(file.headers || {}), ...cli.headers },
    sign: { ...(file.sign || {}), ...cli.sign },
    values: { ...(file.values || {}), ...cli.values },
    statuses: { ...(file.statuses || {}), ...cli.statuses },
    reversalReward: pick('reversalReward'),
    okBody: pick('okBody'),
    balance: { ...(file.balance || {}), ...cli.balance },
    timeoutMs: pick('timeoutMs'),
    slowMs: pick('slowMs'),
    checks: pick('checks'),
    skip: pick('skip'),
    race: pick('race'),
    secretEnv: pick('secretEnv'),
  };

  if (!merged.url) throw new UsageError('Missing the postback URL template. Run with --help for usage.');
  let parsed;
  try {
    parsed = new URL(merged.url.replace(/\{[^}]*\}|\[[^\]]*\]/g, 'x'));
  } catch {
    throw new UsageError(`Not a valid URL: ${merged.url}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new UsageError('The URL must start with http:// or https://');

  // The Moonetix preset is fixed. Refuse options that would make it something else.
  const changed = {
    method: merged.method && merged.method !== preset.method,
    sign: Object.keys(merged.sign).length > 0,
    statuses: Object.keys(merged.statuses).length > 0,
    reversalReward: merged.reversalReward !== undefined,
    body: merged.body !== undefined,
    bodyType: merged.bodyType !== undefined,
    headers: Object.keys(merged.headers).length > 0,
  };
  for (const key of preset.locked) {
    if (changed[key]) throw new UsageError(`The ${preset.id} preset does not allow changing ${key}. Use --preset custom.`);
  }

  const sign = { ...preset.sign, ...merged.sign };
  if (!ALGORITHMS.includes(sign.algo)) throw new UsageError(`Unknown --sign ${sign.algo}. Use one of ${ALGORITHMS.join(', ')}.`);
  if (!ENCODINGS.includes(sign.encoding)) throw new UsageError(`Unknown --sign-encoding ${sign.encoding}. Use hex, HEX or base64.`);
  if (sign.algo !== 'none' && !sign.input) throw new UsageError('--sign needs --sign-input, the template of what is signed.');
  if (sign.algo !== 'none' && macrosIn(sign.input, preset.syntax).has('body')) {
    if (merged.body === undefined) throw new UsageError('--sign-input uses {body}, but there is no --body.');
    const inBody = macrosIn(merged.body, preset.syntax);
    if (preset.signatureMacros.some((m) => inBody.has(m))) throw new UsageError('A signed body cannot contain the signature. Send it with --sign-header.');
  }

  const secretVars = merged.secretEnv ? [merged.secretEnv] : preset.secretEnv;
  const secretVar = secretVars.find((v) => env[v]);
  const secret = secretVar ? env[secretVar] : '';
  const syntax = preset.syntax;
  const usesSecret = sign.algo.startsWith('hmac') || [merged.url, merged.body, sign.input, ...Object.values(merged.headers)]
    .some((t) => t && macrosIn(t, syntax).has('secret'));
  if (usesSecret && !secret) throw new UsageError(`No secret. Set ${secretVars.join(' or ')}.`);

  const method = merged.method || preset.method;
  if (!['GET', 'POST', 'PUT'].includes(method)) throw new UsageError(`Unsupported method ${method}. Use GET or POST.`);
  const bodyType = merged.bodyType || 'form';
  if (!['form', 'json', 'raw'].includes(bodyType)) throw new UsageError(`Unknown --body-type ${bodyType}. Use form, json or raw.`);
  if (merged.body !== undefined && method === 'GET') throw new UsageError('A body needs --method POST.');

  if (preset.macros) {
    for (const k of Object.keys(merged.values)) {
      if (!preset.macros.includes(k) || preset.signatureMacros.includes(k)) {
        throw new UsageError(`Moonetix has no settable macro {${k}}. Settable: ${preset.macros.filter((m) => m !== 'hash').join(', ')}.`);
      }
    }
  }

  const reversalReward = merged.reversalReward || preset.reversalReward;
  if (!['same', 'negative'].includes(reversalReward)) throw new UsageError('--reversal-reward must be same or negative.');

  let checks = merged.checks || CHECKS;
  for (const c of [...checks, ...(merged.skip || [])]) {
    if (!CHECKS.includes(c)) throw new UsageError(`Unknown check ${c}. Checks: ${CHECKS.join(', ')}.`);
  }
  checks = CHECKS.filter((c) => checks.includes(c) && !(merged.skip || []).includes(c));
  const race = merged.race === undefined ? 5 : Number(merged.race);
  if (!Number.isInteger(race) || race < 0 || race > 50) throw new UsageError('--race must be a whole number from 0 to 50.');
  if (race === 0) checks = checks.filter((c) => c !== 'race');

  let okBody = null;
  if (merged.okBody) {
    try {
      okBody = new RegExp(merged.okBody);
    } catch (e) {
      throw new UsageError(`Invalid --ok-body: ${e.message}`);
    }
  }
  const timeoutMs = merged.timeoutMs === undefined ? 10000 : Number(merged.timeoutMs);
  const slowMs = merged.slowMs === undefined ? 6000 : Number(merged.slowMs);
  if (!(timeoutMs > 0) || !(slowMs > 0)) throw new UsageError('--timeout and --slow must be positive numbers of milliseconds.');

  return {
    preset,
    url: merged.url,
    method,
    body: merged.body,
    bodyType,
    headers: { ...preset.headers, ...merged.headers },
    userAgent: preset.userAgent,
    sign,
    secret,
    syntax,
    values: { ...preset.defaults(), ...merged.values },
    statuses: { ...preset.statuses, ...merged.statuses },
    reversalReward,
    okBody,
    balance: merged.balance.url ? { url: merged.balance.url, path: merged.balance.path || null } : null,
    timeoutMs,
    slowMs,
    checks,
    race,
    json: Boolean(cli.json),
    summary: cli.summary || null,
    verbose: Boolean(cli.verbose),
    dryRun: Boolean(cli.dryRun),
  };
}

module.exports = { parseArgs, resolveConfig, UsageError, CHECKS, HELP };
