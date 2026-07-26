# Development and validation

## Credential-free checks

The automated suite uses temporary filesystem roots, synthetic messages, and mocked Google clients. It does not need or read real Google credentials.

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

The pack listing should contain the manifest, license, README, documentation, and `src/` only—not tests, initiative artifacts, credentials, tokens, coverage, or generated tarballs. Never add real account data, authorization URLs/codes, client JSON, token JSON, or token-bearing logs to Git or CI fixtures.

## Optional dedicated-account smoke test

This is manual, opt-in validation, not a CI gate. Use a dedicated test account, disposable messages, and a dedicated writable non-primary calendar. Install credentials only at the paths documented in the README. Do not capture secrets or authorization URLs in terminal recordings or logs.

Before starting, install/reload the package and ensure the old Gmail extension is disabled. Keep IDs/page tokens only as transient test notes.

### 1. Independent authentication and logout isolation

1. Run `/gws-status`; verify the shared client is configured and both app states are reported without credential contents.
2. Run `/gws-login gmail`, manually open the URL, grant access, and verify only `gmail-token.json` appears.
3. Run `/gws-login calendar`, grant access separately, and verify `calendar-token.json` appears without changing the Gmail token.
4. Run `/gws-status gmail` and `/gws-status calendar`.
5. Run `/gws-logout gmail`, confirm it, and verify Calendar remains authenticated.
6. Re-run `/gws-login gmail` for the remaining checks.

### 2. Gmail reads, reversible movement, and drafts

1. Ask Pi to use `gws_gmail_search` with a narrow query for a disposable message and a small result limit.
2. Read one result with `gws_gmail_read_message`; verify sender, subject, date, and plain-text content are sensible.
3. Explicitly request moving that test message to Archive. Check the confirmation identifies the message and destination, then confirm. Explicitly move the same message back to Inbox and confirm again.
4. Request a new plain-text draft to an address owned by the test account. Confirm only after checking recipients, subject, and body. Verify a draft exists in Gmail, then delete it in Gmail without sending.
5. Request a single-recipient reply draft to the disposable source message. Verify it appears in the existing thread with the expected recipient and subject, then delete it without sending.
6. Start another move or draft operation and cancel its dialog. Verify the tool reports cancellation as a non-error and Gmail is unchanged.

Do not test mail sending: no send operation exists.

### 3. Calendar discovery and event listing

1. Use `gws_calendar_list` with a result limit smaller than the account's calendar count. If `nextPageToken` is returned, pass it explicitly to fetch one next page.
2. Use `gws_calendar_list_events` without a calendar or range. Verify it queries `primary`, covers now through exactly seven days later, and returns expanded, non-cancelled events in start order.
3. Repeat with an explicit writable non-primary calendar, narrow offset-free local start/end values, an IANA time zone, and a harmless query. If a next-page token is available, request only one next page.

### 4. Confirmed Calendar creation and failures

Use clearly marked test summaries and remove created events afterward in Google Calendar; this package intentionally has no delete tool.

1. Create a short timed event on `primary` with explicit local start/end values and an IANA time zone. Inspect the calendar name/ID, summary, range, zone, description, and location in the confirmation before accepting.
2. Create an all-day event on the dedicated non-primary writable calendar. Verify the confirmation shows the exclusive end date.
3. Start a third creation and cancel. Verify no event is created and cancellation is a non-error.
4. Attempt creation on a calendar with a read-only role. Verify it fails safely without an insert.
5. If exercising retry behavior from a harness capable of preserving the same Pi tool-call ID, repeat the identical call and verify the existing event is recovered rather than duplicated. Ordinary separate invocations intentionally create separate events.

After testing, delete test drafts/events in Google's UI, restore the disposable message's original location, and optionally run both per-app logout commands. Revoke grants in Google account security settings if the test authorization is no longer needed.
