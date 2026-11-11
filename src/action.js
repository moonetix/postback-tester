'use strict';

// Entry point for action.yml. Inputs arrive as environment variables so that
// nothing from the workflow file is ever interpolated into a shell command.

const { main } = require('./cli');

// Splits a string like a POSIX shell would for plain words and quotes.
function splitArgs(s) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
    }
  }
  if (quote) throw new Error('Unclosed quote in args');
  if (has || cur) out.push(cur);
  return out;
}

function argsFromEnv(env) {
  const argv = [];
  if (env.PT_URL) argv.push(env.PT_URL);
  if (env.PT_PRESET) argv.push('--preset', env.PT_PRESET);
  if (env.PT_CONFIG) argv.push('--config', env.PT_CONFIG);
  if (env.PT_ARGS) argv.push(...splitArgs(env.PT_ARGS));
  if (env.GITHUB_STEP_SUMMARY && env.PT_SUMMARY !== 'false') argv.push('--summary', env.GITHUB_STEP_SUMMARY);
  return argv;
}

if (require.main === module) {
  let argv;
  try {
    argv = argsFromEnv(process.env);
  } catch (e) {
    process.stderr.write(`postback-tester: ${e.message}\n`);
    process.exit(2);
  }
  main(argv).then((code) => {
    process.exitCode = code;
  }, (e) => {
    process.stderr.write(`postback-tester: ${e.stack || e.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = { splitArgs, argsFromEnv };
