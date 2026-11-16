import { ALGORITHMS, ENCODINGS } from './core.js';
import { build, newIds, presets, stateFrom } from './signer.js';

const $ = (id) => document.getElementById(id);
const TEST_KEY = 'test_postback_key_not_secret';
const MODES = ['strict', 'naive'];

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === false || value == null) continue;
    if (name === 'class') el.className = value;
    else if (name === 'text') el.textContent = value;
    else el.setAttribute(name, value === true ? '' : value);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';

function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const tagClass = { PASS: 'good', FAIL: 'bad', SKIP: 'skip' };
const tagIcon = { PASS: 'check', FAIL: 'x', SKIP: null };
const tally = (s) => `${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`;
const signed = (n) => (n > 0 ? `+${n}` : String(n));

let data = null;
try {
  const res = await fetch('data.json');
  if (!res.ok) throw new Error(String(res.status));
  data = await res.json();
} catch {
  $('run-wait').textContent = 'The recorded run could not be loaded. Reload the page to try again.';
  $('hero-preview').replaceChildren(h('p', { class: 'muted', text: 'The recorded run could not be loaded.' }));
}

function label(r) {
  return h('span', { class: `tag ${tagClass[r.label]}` }, tagIcon[r.label] ? icon(tagIcon[r.label]) : null, h('span', { class: 'mono', text: r.label }));
}

function result(mode, handler, r) {
  return h(
    'span',
    { class: `res res-${mode} ${tagClass[r.label]}` },
    h('span', { class: 'res-who', text: handler.title }),
    h('span', { class: 'res-line' }, label(r), h('span', { class: 'st', text: r.http }), r.ms === null ? null : h('span', { class: 'ms', text: `${r.ms} ms` })),
    h('span', { class: 'res-detail', text: r.detail }),
  );
}

function requests(mode, handler, r) {
  return h(
    'div',
    { class: `reqs reqs-${mode}` },
    h('h4', { text: `${handler.title}: requests and answers` }),
    h(
      'ol',
      {},
      r.requests.map((q) => {
        const note = q.cleanup ? 'Afterwards, to clean up: the reversal of this credit' : q.n > 1 ? `Sent ${q.n} times at the same moment` : null;
        return h(
          'li',
          {},
          note ? h('p', { class: 'req-note', text: note }) : null,
          h('p', { class: 'req', text: q.line }),
          h('p', { class: 'ans' }, h('span', { class: 'ans-l', text: 'Answer' }), q.answers.map((a) => h('code', { text: a.n > 1 ? `${a.n} x ${a.text}` : a.text }))),
        );
      }),
    ),
    r.balance
      ? h(
          'p',
          { class: 'bal' },
          `Balance of the test user: ${r.balance.before} to ${r.balance.after}`,
          r.balance.delta === r.balance.expected ? '' : `, expected a change of ${signed(r.balance.expected)}`,
        )
      : null,
  );
}

function answerCells(r) {
  const box = h('span', { class: 'cells' });
  const first = r.requests.find((q) => !q.cleanup) || r.requests[0];
  for (const a of first.answers) for (let i = 0; i < a.n; i += 1) box.append(h('i', { class: 'cell', text: a.text }));
  return box;
}

function openCheck(hash, scroll) {
  const target = hash && hash.startsWith('#check-') ? document.getElementById(hash.slice(1)) : null;
  if (!target || target.tagName !== 'DETAILS') return;
  target.open = true;
  if (scroll) target.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

if (data) {
  const race = data.checks.find((c) => c.id === 'race');
  $('hero-preview').replaceChildren(
    ...MODES.map((mode) => {
      const r = race[mode];
      const kind = tagClass[r.label];
      return h(
        'div',
        { class: `sample-row ${kind}` },
        h('span', { class: 'sample-l' }, h('span', { text: data.handlers[mode].title }), label(r)),
        answerCells(r),
        h('span', { class: 'sample-out', text: r.detail }),
      );
    }),
  );

  $('run-handlers').replaceChildren(
    h('p', { class: 'head-l', text: `Each of the ${data.checks.length} checks below went to both handlers. PASS and FAIL are the labels the tool printed, next to the HTTP status, the time and its own explanation.` }),
    ...MODES.map((mode) => {
      const handler = data.handlers[mode];
      const failed = handler.summary.failed > 0;
      return h(
        'div',
        { class: `handler handler-${mode} ${failed ? 'bad' : 'good'}` },
        h('h3', { text: handler.title }),
        h(
          'p',
          { class: `tag ${failed ? 'bad' : 'good'}` },
          icon(failed ? 'x' : 'check'),
          failed ? `${handler.summary.failed} of ${data.checks.length} failed` : `all ${data.checks.length} passed`,
        ),
        h('p', { class: 'handler-does', text: handler.does }),
        h('p', { class: 'tally mono' }, h('span', { text: tally(handler.summary) }), h('span', { text: `exit code ${handler.exitCode}` })),
      );
    }),
  );

  $('run-checks').replaceChildren(
    ...data.checks.map((c, i) =>
      h(
        'details',
        { class: 'check', id: `check-${c.id}` },
        h(
          'summary',
          {},
          h('span', { class: 'check-n', text: String(i + 1).padStart(2, '0') }),
          h('span', { class: 'check-t' }, h('span', { class: 'check-title', text: c.title }), h('span', { class: 'check-meta', text: c.sends })),
          ...MODES.map((mode) => result(mode, data.handlers[mode], c[mode])),
          icon('down'),
        ),
        h(
          'div',
          { class: 'check-body' },
          h(
            'dl',
            { class: 'check-dl' },
            h('div', {}, h('dt', { text: 'A correct endpoint' }), h('dd', { text: c.correct })),
            h('div', {}, h('dt', { text: 'What a failure costs' }), h('dd', { text: c.cost })),
          ),
          ...MODES.map((mode) => requests(mode, data.handlers[mode], c[mode])),
        ),
      ),
    ),
  );

  openCheck(location.hash, true);
  window.addEventListener('hashchange', () => openCheck(location.hash, false));
  $('sample-open').addEventListener('click', () => openCheck('#check-race', false));
}

const FIELDS = {
  url: 'sg-url',
  key: 'sg-key',
  algo: 'sg-algo',
  encoding: 'sg-encoding',
  input: 'sg-input',
  header: 'sg-header',
  reversalReward: 'sg-reversal-reward',
  creditStatus: 'sg-credit-status',
  reversalStatus: 'sg-reversal-status',
  method: 'sg-method',
  bodyType: 'sg-body-type',
  body: 'sg-body',
  user: 'sg-user',
  reward: 'sg-reward',
  tx: 'sg-tx',
  payout: 'sg-payout',
  values: 'sg-values',
  balanceUrl: 'sg-balance-url',
  balancePath: 'sg-balance-path',
  okBody: 'sg-ok-body',
};

const form = $('sg-form');
const radios = [...form.elements.preset];
const starts = data ? data.starts : [];
let state;
let turn = 0;

for (const algo of ALGORITHMS) $('sg-algo').append(h('option', { text: algo }));
for (const encoding of ENCODINGS) $('sg-encoding').append(h('option', { text: encoding }));
starts.forEach((start, i) => $('sg-start').append(h('option', { value: String(i), text: start.title })));
if (!starts.length) $('sg-start').closest('.field').hidden = true;

function describePreset(preset) {
  if (!preset.locked.includes('sign')) return 'Any other network. Nothing is signed until you choose an algorithm and say what is signed.';
  return `Fixed by this preset: ${preset.method}, ${preset.sign.algo.toUpperCase()} of ${preset.sign.input} as ${preset.sign.encoding}, status ${preset.statuses.credit} for a credit and ${preset.statuses.reversal} for a reversal.`;
}

function sync() {
  const preset = presets[state.preset];
  $('sg-custom').hidden = preset.locked.includes('sign');
  $('sg-fixed').textContent = describePreset(preset);
  const noBody = state.method === 'GET';
  $('sg-body-type-field').hidden = noBody;
  $('sg-body-field').hidden = noBody;
}

function load(next) {
  state = next;
  for (const [name, id] of Object.entries(FIELDS)) $(id).value = state[name];
  for (const radio of radios) radio.checked = radio.value === state.preset;
  sync();
  render();
}

function sentence(text) {
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

function show(out) {
  const unsignedRun = out.credit.signature === null;
  $('sg-signed').closest('div').hidden = unsignedRun;
  $('sg-signature').closest('div').hidden = unsignedRun;
  $('sg-signed').textContent = out.credit.signed ?? '';
  $('sg-signature').textContent = out.credit.signature ?? '';
  $('sg-how').textContent = `Signature: ${out.sign.algo}, ${out.sign.encoding}${out.sentAs.length ? `, sent as ${out.sentAs.join(' and ')}` : ''}`;
  $('sg-url-out').textContent = out.credit.url;
  $('sg-warn').hidden = out.notes.length === 0;
  $('sg-warn').textContent = out.notes.map(sentence).join(' ');
  $('sg-curl-credit').textContent = out.credit.curl;
  $('sg-curl-duplicate').textContent = out.credit.curl;
  $('sg-curl-reversal').textContent = out.reversal.curl;
  $('sg-forged').hidden = out.forged === null;
  if (out.forged) {
    $('sg-forged-title').textContent = `4. ${out.forged.title}: expect a rejection, balance unchanged`;
    $('sg-curl-forged').textContent = out.forged.curl;
  }
  $('sg-command').textContent = out.command;
}

async function render() {
  const mine = ++turn;
  const error = $('sg-error');
  let out = null;
  let message = '';
  try {
    out = await build(state);
  } catch (err) {
    message = err.message;
  }
  if (mine !== turn) return;
  error.hidden = out !== null;
  error.textContent = message;
  for (const part of $('sg-out').children) if (part !== error) part.hidden = out === null;
  if (out) show(out);
}

form.addEventListener('input', (ev) => {
  if (ev.target === $('sg-start')) {
    load({ ...stateFrom(null, starts[Number(ev.target.value)].argv), key: state.key });
    return;
  }
  if (ev.target.name === 'preset') {
    load({ ...stateFrom(ev.target.value), url: state.url, key: state.key });
    return;
  }
  for (const [name, id] of Object.entries(FIELDS)) state[name] = $(id).value;
  sync();
  render();
});
form.addEventListener('submit', (ev) => ev.preventDefault());

$('sg-new').addEventListener('click', () => {
  Object.assign(state, newIds(state.preset));
  $('sg-tx').value = state.tx;
  render();
});

load({ ...(starts.length ? stateFrom(null, starts[0].argv) : stateFrom('moonetix')), key: TEST_KEY });
