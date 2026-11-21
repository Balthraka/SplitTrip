# SplitTrip API

A small Cloudflare Worker and D1 database behind a single-page expense-splitting app (`web/index.html`). Trips have members, expenses are split between members, and the app works out who owes whom. Sign-in is Google (and optionally Microsoft); no passwords and no email are sent.

## What is here
- `src/` the Worker routes (trips, members, expenses, payments, account). Money is stored as whole cents. A trip's expense and its splits are written in one atomic batch. Edits carry a version number, and a stale edit is refused.
- `core/` the shared sign-in, session and routing layer (also used by other apps; do not edit it here, `scripts/check-core.mjs` compares copies).
- `schema/` the D1 table definitions.
- `web/index.html` the page (React and Babel in the browser, pinned to exact versions with integrity hashes; Tailwind CSS is built ahead of time with `npm run build:css`).
- `scripts/` an importer for moving an existing export in, and checks.
- `test/`, `test-web/` the tests. They use made-up data only.

## Setup
1. `npm install`
2. Create the database: `npx wrangler d1 create splittrip`, then put its id in `wrangler.toml` (the file holds a placeholder).
3. Put your own page address in `ALLOWED_ORIGINS` and your Worker address in `API_BASE` in `web/index.html`.
4. `npx wrangler d1 migrations apply splittrip --remote`, set `GOOGLE_CLIENT_ID`, then `npx wrangler deploy`.

## Checks
`npm test` (unit and API tests), `npm run typecheck`, `npm run check:css` (the built CSS in the page is current). `docs/PRIVACY-HOSTS.md` lists every outside host the page contacts.
