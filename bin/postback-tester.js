#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`postback-tester: ${e.stack || e.message}\n`);
    process.exitCode = 2;
  },
);
