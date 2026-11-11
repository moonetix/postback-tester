# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-11

### Added

- Ten checks: credit, duplicate credit, reversal, duplicate reversal, reversal of an unknown transaction, tampered signature, tampered reward, wrong secret, missing signature, and the same credit sent in parallel.
- `moonetix` preset that reproduces Moonetix postbacks byte for byte, verified against 132 postbacks built by the Moonetix postback code.
- `custom` preset: `{macro}` and `[MACRO]` syntax, md5, sha1, sha256, HMAC-SHA1 and HMAC-SHA256 signatures over any template or the raw body, signature in the URL, body or a header, GET or POST with form, JSON or raw bodies, custom status values, negative rewards on reversals.
- Balance checks through a `--balance-url` that reads the test user's balance before and after each check.
- Timing limits, redirect detection, text, JSON and Markdown reports, exit codes for CI.
- GitHub Action (`action.yml`) with a job summary.
- Example server in `examples/echo-server.js` with a strict and a naive mode.

[1.0.0]: https://github.com/moonetix/postback-tester/releases/tag/v1.0.0
