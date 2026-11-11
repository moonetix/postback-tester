'use strict';

const fs = require('node:fs');
const { parseArgs, resolveConfig, UsageError, HELP } = require('./config');
const { runChecks } = require('./runner');
const report = require('./report');
const { version } = require('../package.json');

// Returns the exit code: 0 all checks passed, 1 a check failed, 2 usage error.
async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let cfg;
  try {
    const cli = parseArgs(argv);
    if (cli.help) {
      stdout.write(HELP);
      return 0;
    }
    if (cli.version) {
      stdout.write(`${version}\n`);
      return 0;
    }
    cfg = resolveConfig(cli, env);
  } catch (e) {
    if (e instanceof UsageError) {
      stderr.write(`postback-tester: ${e.message}\n`);
      return 2;
    }
    throw e;
  }

  const run = await runChecks(cfg);
  stdout.write(cfg.json ? report.json(cfg, run, version) : report.text(cfg, run, version));
  if (cfg.summary) fs.appendFileSync(cfg.summary, report.markdown(cfg, run, version));
  return run.summary.failed > 0 ? 1 : 0;
}

module.exports = { main };
