// Assembles the GitHub Pages demo in _site/ (or in the folder given with --out).
//
// The run on the page is recorded here: this script starts examples/echo-server.js
// with its correct handler and with its naive one, runs the command line tool
// against each, and writes down what it reported. It stops with an error when the
// correct handler fails a check or the naive one does not fail the checks the
// README says it fails.
//
// The signer on the page uses the modules in src/ themselves; they are wrapped into
// one browser module, core.js. The command line examples on the page are cut out of
// README.md, so the two cannot drift apart.
//
// Node built-ins only. Run: node scripts/build-site.mjs
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFlag = process.argv.indexOf('--out');
const out = outFlag > -1 ? resolve(process.argv[outFlag + 1]) : join(root, '_site');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const require = createRequire(import.meta.url);

const { main } = require('../src/cli.js');
const { parseArgs, resolveConfig, CHECKS } = require('../src/config.js');
const { TITLES } = require('../src/runner.js');
const { presets } = require('../src/presets.js');
const { version } = require('../package.json');

const KEY = 'test_postback_key_not_secret';
const TOOL = 'npx github:moonetix/postback-tester';

// What a failed check means for the balance sheet. The request and the expected
// answer of each check come from the table in the README.
const COSTS = {
  credit: 'A user completes an offer and gets nothing. The network has paid you, the reward is missing, and the user writes to support or leaves.',
  duplicate: 'Networks send a postback again when the first answer was slow or lost. A handler that credits each request pays one conversion two or three times.',
  reversal: 'The advertiser took the payout back from you, but the user keeps the reward. Every chargeback and every rejected lead becomes your loss.',
  'duplicate-reversal': 'The reward is taken away twice. The balance drops below what the user earned, and somebody has to find and correct it by hand.',
  'unknown-reversal': 'A balance is reduced for a reward that was never paid. Or the handler answers with an error, the network keeps retrying, and a credit that arrives late is paid although it was already reversed.',
  'tampered-signature': 'The signature is not compared at all. Anyone who learns the URL can credit any amount to any account, as often as they like.',
  'tampered-reward': 'The signature is checked, but not against the amount. A user who sees one genuine postback can send it again with a larger reward.',
  'wrong-secret': 'The handler accepts anything that looks like a signature, so the secret key protects nothing.',
  'missing-signature': 'A handler that only verifies a signature when one is present can be credited with plain unsigned requests.',
  race: 'Retries can overlap. A handler that first looks for the transaction and then inserts it credits every copy that arrives in between. Only a unique key in the database stops this.',
};

const HANDLERS = {
  strict: {
    title: 'Correct handler',
    env: { MOONETIX_POSTBACK_KEY: KEY },
    does: 'Verifies the hash before anything else, stores each transaction ID once, and reverses exactly what that transaction credited.',
  },
  naive: {
    title: 'Naive handler',
    env: { MODE: 'naive' },
    does: 'Skips the hash and credits every request it receives. It still answers 200, so one test postback from a dashboard looks fine.',
  },
};

const NAIVE_PASSES = ['credit', 'reversal'];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (text) => escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>');

// --- README

const readme = read('README.md');

function section(title, level = 2) {
  const marks = '#'.repeat(level);
  const start = readme.indexOf(`\n${marks} ${title}\n`);
  check(start > -1, `README.md has no section "${title}"`);
  const rest = readme.slice(start + 1);
  const next = rest.slice(marks.length).search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next + marks.length);
}

function codeBlocks(text, language) {
  return [...text.matchAll(/```(\w+)\n([\s\S]*?)\n```/g)].filter((m) => m[1] === language).map((m) => m[2]);
}

function firstBlock(title, language, level) {
  const blocks = codeBlocks(section(title, level), language);
  check(blocks.length > 0, `README.md: no ${language} block under "${title}"`);
  return blocks[0];
}

function shellWords(text) {
  const words = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  for (const m of text.matchAll(re)) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

// The arguments of the postback-tester call in a shell snippet.
function argvOf(snippet) {
  const joined = snippet.replace(/\\\n\s*/g, ' ');
  const line = joined.split('\n').find((l) => l.includes(TOOL));
  check(line, `No "${TOOL}" call in:\n${snippet}`);
  return shellWords(line.slice(line.indexOf(TOOL) + TOOL.length));
}

const snippets = {
  SNIP_LOCAL: firstBlock('Try it in one minute', 'sh'),
  SNIP_MOONETIX: firstBlock('Test a Moonetix endpoint', 'sh'),
  SNIP_ACTION: firstBlock('GitHub Action', 'yaml', 3),
  SNIP_ANYWHERE: firstBlock('Anywhere else', 'sh', 3),
};

const customExamples = [...section('Test any other network').matchAll(/\*\*([^*\n]+)\*\*\n\n```sh\n([\s\S]*?)\n```/g)].map((m) => ({
  title: m[1],
  code: m[2],
  argv: argvOf(m[2]),
}));
check(customExamples.length >= 3, 'README.md: expected the examples under "Test any other network"');

const starts = [{ title: 'Moonetix postback', argv: argvOf(snippets.SNIP_MOONETIX) }, ...customExamples.map(({ title, argv }) => ({ title, argv }))];
for (const start of starts) {
  try {
    resolveConfig(parseArgs(start.argv), { MOONETIX_POSTBACK_KEY: KEY, POSTBACK_SECRET: KEY });
  } catch (err) {
    throw new Error(`README.md example "${start.title}" is not accepted by the tool: ${err.message}`);
  }
}

const table = new Map(
  [...section('What it checks').matchAll(/^\| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)].map((m) => [m[1].trim(), { sends: m[2].trim(), correct: m[3].trim() }]),
);

const rules = [...section('What a passing endpoint does').matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
check(rules.length >= 3, 'README.md: expected the numbered rules under "What a passing endpoint does"');

// --- the recorded run

function startServer(env) {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [join(root, 'examples', 'echo-server.js')], {
      env: { PATH: process.env.PATH, PORT: '0', HOST: '127.0.0.1', ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let seen = '';
    child.stdout.on('data', (chunk) => {
      seen += chunk;
      const m = seen.match(/Listening on (http:\/\/\S+)/);
      if (m) ok({ url: m[1], stop: () => child.kill() });
    });
    child.on('error', fail);
    child.on('exit', (code) => fail(new Error(`examples/echo-server.js exited with ${code}`)));
  });
}

function groupRequests(requests, origin) {
  const groups = [];
  for (const q of requests) {
    const line = `${q.method} ${q.url.replace(origin, '')}`;
    const answer = q.status === null ? q.error : `${q.status} ${q.response.trim()}`.trim();
    const last = groups[groups.length - 1];
    if (last && last.line === line && Boolean(last.cleanup) === Boolean(q.cleanup)) {
      last.n += 1;
      const same = last.answers.find((a) => a.text === answer);
      if (same) same.n += 1;
      else last.answers.push({ text: answer, n: 1 });
    } else {
      groups.push({ line, n: 1, cleanup: Boolean(q.cleanup), answers: [{ text: answer, n: 1 }] });
    }
  }
  return groups;
}

async function record(mode) {
  const server = await startServer(HANDLERS[mode].env);
  const work = mkdtempSync(join(tmpdir(), 'postback-site-'));
  const summaryFile = join(work, 'summary.md');
  let stdout = '';
  let stderr = '';
  let code;
  try {
    code = await main(
      [
        `${server.url}/postback?user={user_id}&tx={transaction_id}&status={status}&reward={reward}&hash={hash}`,
        '--preset', 'moonetix',
        '--balance-url', `${server.url}/balance?user={user_id}`,
        '--balance-path', 'balance',
        '--json',
        '--summary', summaryFile,
      ],
      { env: { MOONETIX_POSTBACK_KEY: KEY }, stdout: { write: (s) => (stdout += s) }, stderr: { write: (s) => (stderr += s) } },
    );
    check(code !== 2, `postback-tester refused to run against the ${mode} handler: ${stderr}`);
    const report = JSON.parse(stdout);
    const summary = readFileSync(summaryFile, 'utf8');
    check(!stdout.includes(KEY) && !summary.includes(KEY), 'the report contains the secret');
    const rows = [...summary.matchAll(/^\| (PASS|FAIL|SKIP) \| (.+?) \| (.*?) \| (.*?) \| (.*?) \|$/gm)];
    check(rows.length === report.checks.length, `${mode}: the Markdown summary has ${rows.length} rows for ${report.checks.length} checks`);
    const checks = {};
    report.checks.forEach((c, i) => {
      const [, label, title, http, time, detail] = rows[i];
      check(title === c.title, `${mode}: summary row ${i + 1} is "${title}", expected "${c.title}"`);
      checks[c.id] = {
        label,
        http,
        ms: time === '' ? null : Number(time.replace(' ms', '')),
        detail,
        balance: c.balance,
        requests: groupRequests(c.requests, server.url),
      };
    });
    return { exitCode: code, summary: report.summary, checks };
  } finally {
    server.stop();
    rmSync(work, { recursive: true, force: true });
  }
}

const runs = {};
for (const mode of Object.keys(HANDLERS)) runs[mode] = await record(mode);

// --- what the page claims must hold

check(JSON.stringify(Object.keys(TITLES)) === JSON.stringify(CHECKS), 'runner.js and config.js list different checks');
for (const id of CHECKS) {
  check(COSTS[id], `no cost text for the check "${id}"`);
  check(table.has(TITLES[id]), `README.md: "What it checks" has no row for "${TITLES[id]}"`);
  for (const mode of Object.keys(HANDLERS)) check(runs[mode].checks[id], `the ${mode} run has no result for "${id}"`);
}

const strictFailed = CHECKS.filter((id) => runs.strict.checks[id].label !== 'PASS');
check(strictFailed.length === 0 && runs.strict.exitCode === 0, `the correct handler must pass every check; not passed: ${strictFailed.join(', ') || 'none'}, exit code ${runs.strict.exitCode}`);

for (const id of CHECKS) {
  const want = NAIVE_PASSES.includes(id) ? 'PASS' : 'FAIL';
  check(runs.naive.checks[id].label === want, `the naive handler: "${id}" is ${runs.naive.checks[id].label}, expected ${want}`);
}
check(runs.naive.exitCode === 1, `the naive handler must make the tool exit with 1, got ${runs.naive.exitCode}`);

const tally = (s) => `${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`;
for (const mode of Object.keys(HANDLERS)) {
  check(readme.includes(tally(runs[mode].summary)), `README.md does not show "${tally(runs[mode].summary)}" for the ${mode} handler`);
}
for (const id of ['duplicate', 'tampered-reward', 'race']) {
  check(readme.includes(runs.naive.checks[id].detail), `README.md does not show the naive result of "${id}": ${runs.naive.checks[id].detail}`);
}

// --- core.js: the modules of src/ for the browser

const CORE = ['amount', 'template', 'sign', 'presets', 'request', 'runner', 'config'];
const BUILTINS = ['node:crypto', 'node:fs', 'node:path'];

function coreModule() {
  const parts = CORE.map((name) => {
    const source = read('src', `${name}.js`);
    for (const m of source.matchAll(/require\('([^']+)'\)/g)) {
      check(BUILTINS.includes(m[1]) || CORE.includes(m[1].replace('./', '')), `src/${name}.js requires ${m[1]}, which core.js does not provide`);
    }
    return `  ${JSON.stringify(`./${name}`)}(module, exports, require, process) {\n${source}\n  },`;
  });
  return `// Built from src/ by scripts/build-site.mjs. Do not edit: change the files in src/ instead.
import * as nodeCrypto from './crypto-shim.js';

const builtins = { 'node:crypto': nodeCrypto, 'node:fs': {}, 'node:path': {} };
const process = { env: {} };
const loaded = {};
const sources = {
${parts.join('\n')}
};

function require(name) {
  if (name in builtins) return builtins[name];
  if (!(name in loaded)) {
    const module = { exports: {} };
    loaded[name] = module;
    sources[name](module, module.exports, require, process);
  }
  return loaded[name].exports;
}

export const { presets } = require('./presets');
export const { parseArgs, resolveConfig, UsageError, CHECKS } = require('./config');
export const { buildRequest } = require('./request');
export const { applicability, TITLES } = require('./runner');
export const { ALGORITHMS, ENCODINGS, sign, tamper } = require('./sign');
export const { fill, macrosIn, rawurlencode } = require('./template');
export const { moonetixAmount } = require('./amount');
`;
}

// --- write the site

const data = {
  built: {
    date: new Date().toISOString().slice(0, 10),
    commit: (process.env.GITHUB_SHA || '').slice(0, 7),
    node: process.version,
  },
  version,
  key: KEY,
  handlers: Object.fromEntries(
    Object.entries(HANDLERS).map(([mode, h]) => [mode, { title: h.title, does: h.does, exitCode: runs[mode].exitCode, summary: runs[mode].summary }]),
  ),
  checks: CHECKS.map((id) => ({
    id,
    title: TITLES[id],
    ...table.get(TITLES[id]),
    cost: COSTS[id],
    strict: runs.strict.checks[id],
    naive: runs.naive.checks[id],
  })),
  starts,
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const name of readdirSync(join(root, 'site')).sort()) {
  if (name === 'index.html') continue;
  cpSync(join(root, 'site', name), join(out, name), { recursive: true });
}
writeFileSync(join(out, 'core.js'), coreModule());
writeFileSync(join(out, 'data.json'), JSON.stringify(data));

const snip = (id, title, code, name) =>
  `<div class="snip"><div class="snip-top"><span>${inline(title)}</span><button class="btn copy" type="button" data-copy="${id}" data-name="${escapeHtml(name)}">Copy</button></div>` +
  `<pre class="code" id="${id}" tabindex="0" role="region" aria-label="${escapeHtml(name)}">${escapeHtml(code)}</pre></div>`;

const outcome = (mode) => {
  const { summary, exitCode } = runs[mode];
  const counted = summary.failed ? `${summary.failed} of ${CHECKS.length} failed` : `${summary.passed} of ${CHECKS.length} passed`;
  return `${counted}, exit code ${exitCode}`;
};
const presetNames = Object.keys(presets);

const fill = {
  ...Object.fromEntries(Object.entries(snippets).map(([name, code]) => [name, escapeHtml(code)])),
  SNIPS_CUSTOM: customExamples.map((e, i) => snip(`run-custom-${i + 1}`, e.title, e.code, `Command: ${e.title}`)).join('\n        '),
  RULES: rules.map((rule) => `<li>${inline(rule)}</li>`).join('\n          '),
  CHECKS: CHECKS.length,
  NAIVE_FAILED: runs.naive.summary.failed,
  VERSION: version,
  STRICT_RESULT: outcome('strict'),
  NAIVE_RESULT: outcome('naive'),
  PRESETS: escapeHtml(`${presetNames.slice(0, -1).join(', ')} and ${presetNames[presetNames.length - 1]}`),
  STARTS: starts.length,
  RACE_SENDS: inline(table.get(TITLES.race).sends),
  BUILT: data.built.date,
  NODE: data.built.node,
  COMMIT: data.built.commit
    ? `<a class="mono" href="https://github.com/moonetix/postback-tester/commit/${escapeHtml(data.built.commit)}">${escapeHtml(data.built.commit)}</a>`
    : 'local build',
};
for (const [name, value] of Object.entries(fill)) check(value !== undefined && value !== null && String(value).trim() !== '', `site/index.html: no value for {{${name}}}`);
let html = read('site', 'index.html');
for (const [name, value] of Object.entries(fill)) html = html.replaceAll(`{{${name}}}`, () => String(value));
const left = html.match(/\{\{[A-Z_]+\}\}/g);
if (left) throw new Error(`site/index.html: unknown placeholders ${[...new Set(left)].join(', ')}`);
writeFileSync(join(out, 'index.html'), html);

console.log(
  `${out === join(root, '_site') ? '_site' : out} built: ${CHECKS.length} checks recorded against both handlers ` +
    `(correct: ${tally(runs.strict.summary)}; naive: ${tally(runs.naive.summary)}), ${starts.length} signer examples from README.md`,
);
