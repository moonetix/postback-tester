'use strict';

function redact(text, secret) {
  if (!secret || text === null || text === undefined) return text;
  const s = String(text);
  const enc = encodeURIComponent(secret);
  return s.split(secret).join('[secret]').split(enc).join('[secret]');
}

function label(r) {
  if (r.skipped) return 'SKIP';
  return r.pass ? 'PASS' : 'FAIL';
}

function describeResult(r, answers) {
  let detail = r.notes.join('; ');
  if (!detail && r.pass) {
    detail = r.expect === 'reject' ? 'rejected' : 'accepted';
    if (r.balance) detail += r.balance.delta === 0 ? ', balance unchanged' : `, balance ${r.balance.delta > 0 ? '+' : ''}${r.balance.delta}`;
    if (r.id === 'race') detail += ` (${answers.length} parallel requests)`;
  }
  return detail;
}

function line(r) {
  const answers = r.requests.filter((q) => !q.cleanup && (q.status !== undefined || q.error !== undefined));
  const codes = [...new Set(answers.map((a) => (a.status === null ? 'ERR' : String(a.status))))].join(',');
  const ms = answers.length ? Math.max(...answers.map((a) => a.ms)) : null;
  const parts = [
    `  ${label(r)}  ${r.title.padEnd(36)}`,
    (codes || '-').padStart(7),
    (ms === null ? '' : `${ms} ms`).padStart(9),
  ];
  const detail = describeResult(r, answers);
  return parts.join('') + (detail ? `  ${detail}` : '');
}

function verboseLines(r, secret) {
  const out = [];
  for (const q of r.requests) {
    out.push(`        ${q.cleanup ? '(cleanup) ' : ''}${q.method} ${redact(q.url, secret)}`);
    for (const [k, v] of Object.entries(q.headers || {})) out.push(`          ${k}: ${redact(v, secret)}`);
    if (q.body !== null && q.body !== undefined) out.push(`          body: ${redact(q.body, secret)}`);
    if (q.status !== undefined) {
      const answer = (q.response || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      out.push(`        -> ${q.status === null ? q.error : q.status} in ${q.ms} ms${answer ? `: ${redact(answer, secret)}` : ''}`);
    }
  }
  return out;
}

function text(cfg, run, version) {
  const out = [];
  out.push(`postback-tester ${version}  preset ${cfg.preset.id}  ${cfg.method} ${redact(cfg.url, cfg.secret)}`);
  out.push('');
  for (const r of run.results) {
    out.push(line(r));
    if (cfg.verbose || cfg.dryRun) out.push(...verboseLines(r, cfg.secret));
  }
  out.push('');
  for (const w of run.warnings) out.push(`Warning: ${w}.`);
  const s = run.summary;
  out.push(`${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`);
  return out.join('\n') + '\n';
}

function json(cfg, run, version) {
  const clean = JSON.parse(redact(JSON.stringify(run.results), cfg.secret));
  return JSON.stringify({
    tool: 'postback-tester',
    version,
    preset: cfg.preset.id,
    method: cfg.method,
    url: redact(cfg.url, cfg.secret),
    summary: run.summary,
    warnings: run.warnings,
    checks: clean,
  }, null, 2) + '\n';
}

function markdown(cfg, run, version) {
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const rows = run.results.map((r) => {
    const answers = r.requests.filter((q) => !q.cleanup && q.status !== undefined);
    const codes = [...new Set(answers.map((a) => (a.status === null ? 'error' : a.status)))].join(', ');
    const ms = answers.length ? `${Math.max(...answers.map((a) => a.ms))} ms` : '';
    return `| ${label(r)} | ${esc(r.title)} | ${codes} | ${ms} | ${esc(describeResult(r, answers))} |`;
  });
  const s = run.summary;
  return [
    `### Postback test: ${s.failed ? 'failed' : 'passed'}`,
    '',
    `\`${cfg.method} ${esc(redact(cfg.url, cfg.secret))}\` with preset \`${cfg.preset.id}\`, postback-tester ${version}`,
    '',
    '| Result | Check | HTTP | Time | Details |',
    '| --- | --- | --- | ---: | --- |',
    ...rows,
    '',
    ...run.warnings.map((w) => `Warning: ${w}.`),
    `${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`,
    '',
  ].join('\n');
}

module.exports = { text, json, markdown, redact };
