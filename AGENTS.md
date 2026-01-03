# AGENTS.md

This file documents repo-specific agent instructions for Codex or other coding agents.

## Project overview
- Node.js CLI tool: `slack-cli-stream`
- Entry point: `bin/slack-cli-stream`
- Main library code: `lib/*.js`
- Tests: `test/*`

## Common commands
- Install deps: `npm install`
- Lint: `npm run lint` (eslint on `lib/*.js` and `bin/*`)
- Test: `npm test` (runs lint, then mocha with `test/helper.js`)

## Notes
- CLI is exposed via `bin` in `package.json`
