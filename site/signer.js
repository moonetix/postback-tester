// The signer behind the form. It turns the form into the same argument list
// the command line takes, hands it to the tester's own parseArgs, resolveConfig
// and buildRequest (core.js is built from src/), and describes the requests.

import { presets, parseArgs, resolveConfig, UsageError, buildRequest, applicability, macrosIn, TITLES } from './core.js';
import { settle } from './crypto-shim.js';

export { presets, UsageError, TITLES };

export const FORGERIES = ['tampered-reward', 'tampered-signature', 'wrong-secret', 'missing-signature'];
const OWN_FIELDS = ['user_id', 'reward', 'payout'];
const SAFE_WORD = /^[A-Za-z0-9_\-.,:/=@%+]+$/;

export function quote(word) {
  const text = String(word);
  return SAFE_WORD.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

export function newIds(presetId) {
  const preset = presets[presetId];
  return {
    tx: preset.newTransactionId(),
    eventId: preset.newEventId(),
    reversalEventId: preset.newEventId(),
    forgedTx: preset.newTransactionId(),
    forgedEventId: preset.newEventId(),
    timestamp: Math.floor(Date.now() / 1000),
  };
}

function valueLines(values) {
  return Object.entries(values)
    .filter(([name]) => !OWN_FIELDS.includes(name))
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
}

// A form state for a preset, optionally filled from command line arguments
// such as the examples in the README.
export function stateFrom(presetId, argv = null) {
  const cli = argv ? parseArgs(argv) : { headers: {}, values: {}, sign: {}, statuses: {}, balance: {} };
  const id = argv ? cli.preset || 'custom' : presetId;
  const preset = presets[id];
  if (!preset) throw new UsageError(`Unknown preset: ${id}. Use moonetix or custom.`);
  const unsupported = ['config', 'secretEnv', 'timeoutMs', 'slowMs', 'checks', 'skip', 'race', 'json', 'summary', 'verbose', 'dryRun', 'help', 'version']
    .filter((key) => cli[key] !== undefined);
  if (Object.keys(cli.headers).length) unsupported.push('headers');
  if (unsupported.length) throw new UsageError(`The signer form has no field for: ${unsupported.join(', ')}`);
  const values = { ...preset.defaults(), ...cli.values };
  return {
    preset: id,
    url: cli.url || '',
    key: '',
    algo: cli.sign.algo ?? preset.sign.algo,
    input: cli.sign.input ?? preset.sign.input ?? '',
    encoding: cli.sign.encoding ?? preset.sign.encoding,
    header: cli.sign.header ?? '',
    method: cli.method ?? preset.method,
    body: cli.body ?? '',
    bodyType: cli.bodyType ?? 'form',
    creditStatus: cli.statuses.credit ?? preset.statuses.credit,
    reversalStatus: cli.statuses.reversal ?? preset.statuses.reversal,
    reversalReward: cli.reversalReward ?? preset.reversalReward,
    okBody: cli.okBody ?? '',
    balanceUrl: cli.balance.url ?? '',
    balancePath: cli.balance.path ?? '',
    user: values.user_id,
    reward: values.reward,
    payout: values.payout,
    values: valueLines(values),
    ...newIds(id),
  };
}

function parseValueLines(text) {
  const out = [];
  String(text).split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line === '') return;
    const eq = line.indexOf('=');
    if (eq < 1) throw new UsageError(`Other values, line ${i + 1}: write name=value, got ${line}`);
    out.push([line.slice(0, eq).trim(), line.slice(eq + 1)]);
  });
  return out;
}

// The command line arguments that describe the form. Options that still have
// the preset's default are left out, as you would on the command line.
export function toArgv(state) {
  const preset = presets[state.preset];
  const defaults = preset.defaults();
  const argv = [];
  if (state.preset !== 'custom') argv.push('--preset', state.preset);
  argv.push(state.url.trim());
  if (!preset.locked.includes('sign')) {
    if (state.method !== preset.method) argv.push('--method', state.method);
    if (state.method !== 'GET' && state.body !== '') {
      if (state.bodyType !== 'form') argv.push('--body-type', state.bodyType);
      argv.push('--body', state.body);
    }
    if (state.algo !== 'none') {
      argv.push('--sign', state.algo, '--sign-input', state.input);
      if (state.encoding !== preset.sign.encoding) argv.push('--sign-encoding', state.encoding);
      if (state.header.trim() !== '') argv.push('--sign-header', state.header.trim());
    }
    if (state.creditStatus !== preset.statuses.credit) argv.push('--credit-status', state.creditStatus);
    if (state.reversalStatus !== preset.statuses.reversal) argv.push('--reversal-status', state.reversalStatus);
    if (state.reversalReward !== preset.reversalReward) argv.push('--reversal-reward', state.reversalReward);
  }
  if (state.user !== defaults.user_id) argv.push('--user', state.user);
  if (state.reward !== defaults.reward) argv.push('--reward', state.reward);
  if (state.payout !== defaults.payout) argv.push('--payout', state.payout);
  for (const [name, value] of parseValueLines(state.values)) {
    if (defaults[name] !== value) argv.push('--set', `${name}=${value}`);
  }
  if (state.okBody !== '') argv.push('--ok-body', state.okBody);
  if (state.balanceUrl.trim() !== '') {
    argv.push('--balance-url', state.balanceUrl.trim());
    if (state.balancePath.trim() !== '') argv.push('--balance-path', state.balancePath.trim());
  }
  return argv;
}

function needsKey(cli) {
  try {
    resolveConfig(cli, {});
    return false;
  } catch (err) {
    if (err instanceof UsageError && err.message.startsWith('No secret')) return true;
    throw err;
  }
}

function commandLine(state, argv, withKey) {
  const preset = presets[state.preset];
  const rest = [...argv];
  let head = 'npx @moonetix/postback-tester';
  if (rest[0] === '--preset') head += ` ${rest.splice(0, 2).join(' ')}`;
  if (withKey) head = `${preset.secretEnv[0]}=${quote(state.key)} ${head}`;
  const lines = [head, quote(rest.shift())];
  while (rest.length) {
    const flag = rest.shift();
    lines.push(`${flag} ${quote(rest.shift())}`);
  }
  return lines.join(' \\\n  ');
}

export function curl(request) {
  const lines = [`curl -g -i${request.method === 'GET' ? '' : ` -X ${request.method}`} ${quote(request.url)}`];
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (lower === 'user-agent') lines.push(`-A ${quote(value)}`);
    else if (lower !== 'accept' || value !== '*/*') lines.push(`-H ${quote(`${name}: ${value}`)}`);
  }
  if (request.body !== null) lines.push(`--data-raw ${quote(request.body)}`);
  return lines.join(' \\\n  ');
}

async function describe(cfg, event) {
  const { value, digests } = await settle(() => buildRequest(cfg, event));
  const digest = digests[0] || null;
  return {
    method: value.method,
    url: value.url,
    headers: value.headers,
    body: value.body,
    signature: value.signature,
    signed: digest ? digest.input : null,
    curl: curl(value),
  };
}

// Everything the page shows for one form state. Throws UsageError with the
// message the command line would print.
export async function build(state) {
  const argv = toArgv(state);
  const cli = parseArgs(argv);
  const withKey = needsKey(cli);
  if (withKey && state.key === '') throw new UsageError('Enter a test key. This signature is keyed with the postback secret.');
  const cfg = resolveConfig(cli, { MOONETIX_POSTBACK_KEY: state.key, POSTBACK_SECRET: state.key });
  const at = { timestamp: state.timestamp };
  const skipped = applicability(cfg);
  const forgery = FORGERIES.find((id) => !skipped[id]) || null;
  const used = new Set([cfg.url, cfg.body, ...Object.values(cfg.headers)].filter(Boolean).flatMap((t) => [...macrosIn(t, cfg.syntax)]));
  const sentAs = cfg.sign.algo === 'none' ? [] : cfg.preset.signatureMacros.filter((m) => used.has(m)).map((m) => `{${m}}`);
  if (cfg.sign.algo !== 'none' && cfg.sign.header) sentAs.push(`the ${cfg.sign.header} header`);
  const notes = [...new Set(Object.values(skipped))];
  if (cfg.sign.algo !== 'none' && sentAs.length === 0) {
    notes.unshift(`the signature is computed but never sent: put ${cfg.preset.signatureMacros.map((m) => `{${m}}`).join(' or ')} in the URL or the body, or name a signature header`);
  }
  return {
    argv,
    command: commandLine(state, argv, withKey),
    sign: { ...cfg.sign },
    sentAs,
    notes,
    credit: await describe(cfg, { ...at, tx: state.tx, eventId: state.eventId, kind: 'credit' }),
    reversal: await describe(cfg, { ...at, tx: state.tx, eventId: state.reversalEventId, kind: 'reversal' }),
    forged: forgery
      ? { id: forgery, title: TITLES[forgery], ...(await describe(cfg, { ...at, tx: state.forgedTx, eventId: state.forgedEventId, kind: 'credit', mutation: forgery })) }
      : null,
    skipped,
  };
}
