'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { main } = require('../src/cli');

// Runs the CLI in-process and captures its output.
async function run(argv, env = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    env: { ...env },
    stdout: { write: (s) => (out += s) },
    stderr: { write: (s) => (err += s) },
  });
  return { code, out, err };
}

// Starts examples/echo-server.js on a free port. Returns { url, stop }.
function echoServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'examples', 'echo-server.js')], {
      env: { ...process.env, PORT: '0', ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/Listening on (http:\/\/\S+)/);
      if (m) resolve({ url: m[1], log: () => buf, stop: () => child.kill() });
    });
    child.on('exit', (code) => reject(new Error(`echo server exited with ${code}`)));
  });
}

module.exports = { run, echoServer };
