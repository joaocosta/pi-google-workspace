# pi-google-workspace

A Pi package for bounded Gmail and Google Calendar access with shared OAuth infrastructure and independent authorization per app.

## Public surface

Commands:

- `/gws [on|off]` — toggle all Google Workspace tools for the current session, or explicitly enable/disable them.
- `/gws-login gmail|calendar` — authorize one app; with a UI, omitting the app opens a selector.
- `/gws-status [gmail|calendar]` — inspect the current tool switch plus local client and token state without exposing credentials.
- `/gws-logout gmail|calendar` — remove only that app's local token. This does not revoke Google's server-side grant.
- `--gws-enabled` — start a session with all Google Workspace tools enabled; useful with non-interactive `pi -p` runs.

Tools are registered but disabled by default, so their definitions do not consume model context. Run `/gws on` in each session where they are needed. This in-memory switch never persists; new, resumed, forked, and reloaded sessions start disabled unless the `--gws-enabled` flag is supplied for that invocation.

| Tool | Behavior |
| --- | --- |
| `gws_gmail_search` | Searches one bounded page (maximum 20). The default inbox scope excludes spam, trash, and snoozed mail. |
| `gws_gmail_read_message` | Reads and parses one message by Gmail message ID, including recursive attachment metadata. |
| `gws_gmail_download_attachment` | Downloads one explicitly identified attachment into the captured current working directory. |
| `gws_gmail_create_draft` | Creates a plain-text new-message draft after confirmation. |
| `gws_gmail_create_reply_draft` | Creates a single-recipient, threaded plain-text reply draft after confirmation. It is not reply-all. |
| `gws_gmail_move_message` | Moves one message to Inbox, Trash, Archive, or Spam after confirmation; unrelated labels are preserved. |
| `gws_calendar_list` | Lists one page of at most 10 calendars, including IDs and access roles. |
| `gws_calendar_list_events` | Lists one page of at most 20 expanded, non-cancelled events in start order. Defaults to `primary` and now through exactly seven days later. |
| `gws_calendar_create_event` | Creates one confirmed timed or all-day event with a deterministic per-tool-call ID for retry safety. |

Pagination is explicit: list tools return `nextPageToken` when another page exists and never auto-page. Event listing accepts a calendar, query, page token, and offset-free local time range with an IANA time zone. Calendar creation supports only summary, description, location, and timed or all-day timing. For timed events, use offset-free local values and an IANA zone; if omitted, a valid host IANA zone is required. For all-day events, the end date is exclusive.

There is **no Gmail send tool**. Calendar update, delete, attendees, recurrence authoring, and conferencing are outside version 1.

## Gmail attachment workflow

Attachment access requires explicit user intent. Search for a message, read it once with `gws_gmail_read_message`, select exactly one returned `attachmentId`, then call `gws_gmail_download_attachment` with that message ID and attachment ID. Copy the selected metadata values verbatim: `filename` to `sourceFilename`, `mediaType` to `mediaType`, and `size` to `expectedSize`. These values are untrusted hints; the two IDs identify the bytes. The tool never selects by filename, guesses among attachments, bulk-downloads, parses attachment content, or refetches the full message solely for metadata.

A download writes one atomically published file beneath the process current working directory captured for that invocation. An optional `outputFilename` must be a safe filename, not a path; otherwise the untrusted source name is conservatively sanitized. Existing files and symlinks are never overwritten or auto-suffixed. Decoded content is limited to 25 MiB, and filesystems without the required safe hard-link publication support fail cleanly. The response contains only relative path, media type, and actual size metadata—never attachment bytes.

This bounded read materialization does not show a mutation confirmation, so callers must establish explicit attachment-access intent before invoking it. Successfully downloaded files persist and cleanup is caller-owned. A successful response can include a relative temporary filename in `warnings` if post-publication cleanup failed; the complete destination remains valid and the caller should remove the warned temporary entry.

## Installation

Review the package before installation: Pi packages execute with the user's full system access.

From a Git repository (replace the source and pin with a tag or commit when appropriate):

```bash
pi install git:github.com/OWNER/pi-google-workspace@REF
```

From a local checkout:

```bash
git clone <repository-url> pi-google-workspace
cd pi-google-workspace
npm ci
pi install "$PWD"
```

Pi installs runtime dependencies for Git packages. A local path points directly at the checkout, so install dependencies in that checkout first. Start Pi normally, or run `/reload` in an existing Pi session. The package manifest loads only `src/index.ts`.

## Google Cloud setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project.
2. Enable **Gmail API** and **Google Calendar API**.
3. Configure the OAuth consent screen. If the app is in Testing, add the dedicated Google account you will use as a test user.
4. Create an OAuth client ID with application type **Desktop app**.
5. Download its JSON and install it at the shared path:

```bash
install -d -m 700 ~/.pi/agent/gws-oauth
install -m 600 ~/Downloads/client_secret_*.json \
  ~/.pi/agent/gws-oauth/client_secret.json
```

Keep that file out of Git, CI, issue reports, and logs. The package uses exactly these paths:

```text
~/.pi/agent/gws-oauth/client_secret.json
~/.pi/agent/gws-oauth/gmail-token.json
~/.pi/agent/gws-oauth/calendar-token.json
```

The directory is maintained with mode `0700` and credential/token files with mode `0600` where the platform supports POSIX permissions. Token writes are atomic and preserve an existing refresh token when Google returns only a new access token.

## Authorize each app

After installation and `/reload`, authorize only the apps you need, then explicitly enable the tools for the current session:

```text
/gws-login gmail
/gws-login calendar
/gws-status
/gws on
```

Each login copies the complete authorization URL to your clipboard for you to paste into a browser. If clipboard access fails, it prints the URL as a fallback. The package does not launch a browser. It listens on a localhost callback using a transient port and intentionally has no login timeout; cancel an abandoned operation externally and retry. Gmail and Calendar may be authorized to different Google accounts because identity scopes and account matching are intentionally absent.

For a one-shot non-interactive run, supply `--gws-enabled` after authorizing the needed app:

```bash
pi --gws-enabled -p "Search my Gmail for the latest email from Alice and summarize it."
```

Headless mutation requests have no confirmation dialog, so prompts that create drafts or events, or move messages, must express explicit user intent.

One shared Desktop client configuration is used, but tokens and grants remain independent:

**Gmail token** requests only:

```text
https://www.googleapis.com/auth/gmail.modify
```

**Calendar token** requests only:

```text
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/calendar.events
```

No broad combined token exists: authorizing one app neither requests the other app's scopes nor overwrites its token. These grants can technically permit Google operations beyond the package's tools; the registered tool surface is the behavioral boundary. In particular, the package registers draft creation but no mail-sending operation.

## Mutation safety

In interactive Pi sessions, every message move, draft creation, reply-draft creation, and event creation displays a confirmation immediately before mutation. Cancellation is a successful no-op. In headless execution no dialog is possible, so the caller is responsible for establishing explicit user intent before invoking a mutation.

Calendar event IDs are derived from Pi's tool-call ID. Retrying the same creation call recovers the same event after a Google conflict rather than creating a duplicate; a separate confirmed call is a new creation attempt.

## Logout, revocation, and rollback

`/gws-logout gmail` and `/gws-logout calendar` remove only the selected local token. They retain the shared client configuration and the other app's token, and they do not revoke access at Google. To revoke a grant server-side, use the Google account's third-party access/security settings.

When replacing `pi-gmail-extension`, disable or remove the old package to avoid duplicate Gmail capabilities and confusion. Reconfigure the shared client-secret path above and authorize each desired app; there is no token migration.

To roll back, disable/remove `pi-google-workspace` with `pi config` or `pi remove <the-installed-source>`, then optionally reinstall the old extension. Removing the package does not remove OAuth files. Use `/gws-logout` before removal for local per-app token cleanup, or delete/revoke credentials deliberately afterward.

## Development and optional live validation

Credential-free checks and a dedicated-account smoke procedure are in [docs/development.md](docs/development.md). Live Google checks are opt-in and are never a CI requirement.

## License

MIT
