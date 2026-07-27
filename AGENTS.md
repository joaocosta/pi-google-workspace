# AGENTS.md

## Purpose and authority

- `pi-google-workspace` is an installable Pi package for bounded Google Workspace access.
- It provides shared OAuth infrastructure with independently authorized Gmail and Calendar modules.
- It is a breaking successor to `pi-gmail-extension`, not a compatibility layer.
- Infer intended design from source-controlled git commit history.
- Treat `src/`, `test/`, `package.json`, `README.md`, and `docs/development.md` as evidence of current behavior and public contract.
- If commit-history intent and current implementation disagree, investigate and report the disagreement; do not silently bless drift as a requirement.

## Non-negotiable constraints

- `src/index.ts` must remain the composition root and sole Pi extension entry (`package.json` -> `pi.extensions`).
- App modules must not register shared auth commands or know about other apps.
- Gmail and Calendar must remain separate app boundaries and auth/token boundaries.
- Reuse shared OAuth, token, and confirmation infra in `src/auth/*` and `src/extension/*`; do not duplicate it per app.
- OAuth scopes must stay minimum and app-specific:
  - Gmail: `https://www.googleapis.com/auth/gmail.modify`
  - Calendar: `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, `https://www.googleapis.com/auth/calendar.events`
- Do not request identity/OpenID scopes merely to correlate accounts; different apps may use different Google accounts.
- Public tools must use only `gws_*`; slash commands must use only `/gws-*`.
- Gmail supports search/read/move/drafts/reply-drafts; no send tool.
- List tools must stay bounded and must not auto-paginate.
- Interactive mutations require preview and confirmation; cancellation is normal successful no-op.
- Headless mutations proceed only when caller already established explicit user intent; keep this contract visible in schemas/guidance/tests.
- Normal tests and CI must not require Google credentials or network access.
- Never commit credentials, tokens, token-bearing logs, private keys, auth URLs/codes, or real-user data.

## Current public surface

Commands registered by `src/extension/commands.ts` and contract-tested in `test/index.test.ts`/`test/commands.test.ts`:

- `/gws-login`
- `/gws-status`
- `/gws-logout`

Tools registered by `src/gmail/index.ts` and `src/calendar/index.ts`, contract-tested in `test/index.test.ts`:

- `gws_gmail_search`
- `gws_gmail_read_message`
- `gws_gmail_create_draft`
- `gws_gmail_create_reply_draft`
- `gws_gmail_move_message`
- `gws_calendar_list`
- `gws_calendar_list_events`
- `gws_calendar_create_event`

## Architecture map

- `src/index.ts`: injectable composition root; creates token store, app registry, auth service, Gmail registration, Calendar registration, shared commands.
- `src/auth/apps.ts`: OAuth app registry and exact app scopes.
- `src/auth/paths.ts`: app keys and OAuth paths under `~/.pi/agent/gws-oauth`.
- `src/auth/token-store.ts`: JSON credential/token persistence, atomic writes, app-isolated deletion, refresh-token preservation, private POSIX modes where supported.
- `src/auth/oauth.ts`: Google OAuth client factory, localhost loopback login, status, logout, token rotation, sanitized auth errors.
- `src/extension/commands.ts`: `/gws-login`, `/gws-status`, `/gws-logout`, app parsing/selection, safe UI notifications.
- `src/extension/confirmation.ts`: shared mutation confirmation helper; UI confirms, headless returns caller-owned consent.
- `src/gmail/client.ts`: Gmail client/provider seam using Gmail auth only.
- `src/gmail/index.ts`: Gmail tool schemas, registration, bounded search/read, draft/reply/move mutation flow, Gmail mutation serialization.
- `src/gmail/messages.ts`, `mail.ts`, `reply.ts`: MIME/header parsing, plain-text draft construction, reply recipient/thread derivation, validation/sanitization.
- `src/calendar/client.ts`: Calendar client/provider seam using Calendar auth only.
- `src/calendar/index.ts`: Calendar tool schemas, bounded calendar/event listing, event creation preview/confirmation/idempotency, safe failures.
- `src/calendar/events.ts`: event range defaults, offset-free local time parsing, IANA timezone/DST validation, all-day/timed event construction, deterministic event IDs.
- `test/*`: Vitest suite with fixtures/mocks; covers manifest, registration contracts, paths/scopes, OAuth/token behavior, command UX, bounded list behavior, mutation confirmation/cancellation/sanitization, calendar timezone/DST behavior, package contents.

## Security and privacy

- Shared OAuth client config path: `~/.pi/agent/gws-oauth/client_secret.json`.
- App token paths: `~/.pi/agent/gws-oauth/gmail-token.json`, `~/.pi/agent/gws-oauth/calendar-token.json`.
- Directory mode should be `0700`; credential/token files should be `0600` on POSIX platforms. Code ignores unsupported chmod on platforms lacking POSIX mode support.
- Token writes are atomic via temp file + rename; existing refresh tokens are preserved when Google returns refreshed credentials without `refresh_token`.
- `/gws-status` and tool/command failures must not expose credential values, client secrets, access tokens, refresh tokens, or token-bearing raw errors.
- Use synthetic identities such as `example.test` in tests/fixtures/docs. Do not use real Google Workspace data.
- Live smoke tests are opt-in only, documented in `docs/development.md`, and must use a dedicated test account.

## Development and validation

Use these local checks:

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run
git diff --check
```

- Normal tests must be deterministic, mocked or fixture-based, credential-free, and network-free.
- Preserve injectable seams for Google clients, OAuth clients, loopback server, token store, filesystem, and calendar time.
- Update tests when behavior, public names, schemas, scopes, paths, or outputs change.
- Preserve package-manifest and extension-registration contract tests.
- Use synthetic fixtures, not real Workspace data.

## Change guidance

- Before changing behavior, inspect relevant commit messages plus relevant tests.
- Preserve public names unless an explicit, breaking design/contract change authorizes otherwise.
- Add another Workspace app by extending `WorkspaceAppKey`, `APP_STORAGE_DEFINITIONS`, `createWorkspaceAppRegistry`, app client/provider seams, `src/index.ts` composition, docs, and contract tests. Reuse shared OAuth/token/confirmation infra.
- Add Gmail behavior through existing Gmail client/provider/parser/registration seams. Do not add sending unless a design/contract change authorizes it.
- Add Calendar behavior through existing Calendar client/provider/events/registration seams.
- OAuth/token changes require path, scope, isolation, refresh-token, chmod, status, rotation, and sanitization tests.
- Public tool schema or slash-command changes require contract tests plus README/dev-doc updates.
- Mutations must cover preview, confirmation, cancellation no-op, headless explicit-intent guidance, sanitized failure, and tests.
- Calendar time changes must preserve verified IANA timezone and DST validation behavior, including offset-free local inputs for timed events.
- Packaging changes must keep `package.json` `files`, `dependencies`, `peerDependencies`, and `pi.extensions` aligned with README/tests.
- Keep source, tests, package metadata, README, docs, and this file aligned.

## Documentation maintenance

Changes affecting public tools, slash commands, OAuth scopes, credential paths, mutation behavior, packaging, testing workflow, or architecture guidance must update `AGENTS.md`, `README.md`, and/or `docs/development.md` as appropriate.

## Validation checklist for future agents

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm pack --dry-run`
- [ ] `git diff --check`
- [ ] Scan changed files for credentials, tokens, private keys, auth URLs/codes, token-bearing logs, and real-user data.
- [ ] Verify docs match changed behavior.
