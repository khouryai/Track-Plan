# CLAUDE.md — Track Plan

## Git

**Work on `main` and push to it directly** — the owner's standing instruction,
whatever branch a session was started on. No feature branches and no pull
requests. A push to `main` is a deploy: `.github/workflows/pages.yml` publishes
`web/` to GitHub Pages. So run the checks below and see them pass before every
push, not after.

## Verify before pushing

```bash
npm run lint      # ESLint over web/js and tests
npm test          # Node (look-ahead, links, TAWRs), Python (server rules), browser (static site and server.py)
```

The browser suite (`tests/smoke.mjs`) needs Playwright's Chromium; `--only static`
or `--only server` runs one pass, `--shots DIR` saves screenshots.
