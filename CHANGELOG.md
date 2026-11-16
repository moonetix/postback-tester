# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-11-16

### Changed

- The tool is on npm as [`@moonetix/postback-tester`](https://www.npmjs.com/package/@moonetix/postback-tester): `npx @moonetix/postback-tester` replaces `npx github:moonetix/postback-tester`. The GitHub Action is unchanged and stays on `@v1`.

### Added

- A [demo page](https://moonetix.github.io/postback-tester/). Its build starts both handlers of `examples/echo-server.js`, runs the tool against each and records every result, so the page shows what the tool reported and not a description of it. The build fails unless the correct handler passes all ten checks and the naive one fails the same eight, with the same details, as in the README.
- A signer on the demo page that builds the signed credit, its retry, its reversal and a forged request for any URL template, with the signed string and curl commands. It runs the modules of `src/` in the browser, with WebCrypto in place of `node:crypto`; tests compare its requests with the command line tool for both presets, every algorithm and every encoding.

## [1.0.0] - 2026-11-11

### Added

- Ten checks: credit, duplicate credit, reversal, duplicate reversal, reversal of an unknown transaction, tampered signature, tampered reward, wrong secret, missing signature, and the same credit sent in parallel.
- `moonetix` preset that reproduces Moonetix postbacks byte for byte, verified against 132 postbacks built by the Moonetix postback code.
- `custom` preset: `{macro}` and `[MACRO]` syntax, md5, sha1, sha256, HMAC-SHA1 and HMAC-SHA256 signatures over any template or the raw body, signature in the URL, body or a header, GET or POST with form, JSON or raw bodies, custom status values, negative rewards on reversals.
- Balance checks through a `--balance-url` that reads the test user's balance before and after each check.
- Timing limits, redirect detection, text, JSON and Markdown reports, exit codes for CI.
- GitHub Action (`action.yml`) with a job summary.
- Example server in `examples/echo-server.js` with a strict and a naive mode.

[1.1.0]: https://github.com/moonetix/postback-tester/releases/tag/v1.1.0
[1.0.0]: https://github.com/moonetix/postback-tester/releases/tag/v1.0.0
