import type { gmail_v1 } from "googleapis";
import { sanitizeHeader } from "./mail.js";
import { messageHeader } from "./messages.js";

export class GmailReplyDerivationError extends Error {}

export interface GmailReplyDraft {
  readonly to: string;
  readonly subject: string;
  readonly threadId: string;
  readonly inReplyTo: string;
  readonly references: string;
  readonly sourceFrom: string;
  readonly sourceDate: string;
}

const MAILBOX = /^(?:[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+|"(?:[^"\\]|\\.)+")@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)*[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?$/i;

function firstAddressEntry(value: string): string {
  let quoted = false;
  let escaped = false;
  let angleDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && quoted) {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === "<") {
      angleDepth += 1;
    } else if (!quoted && character === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
    } else if (!quoted && angleDepth === 0 && character === ",") {
      return value.slice(0, index);
    }
  }
  return value;
}

/** Extract exactly the first RFC-style mailbox, dropping its display name and later recipients. */
export function extractFirstMailbox(headerValue: string): string | undefined {
  const value = firstAddressEntry(sanitizeHeader(headerValue)).trim();
  if (!value) return undefined;

  const angleAddress = value.match(/<([^<>]*)>/);
  const candidate = (angleAddress?.[1] ?? value).trim();
  return MAILBOX.test(candidate) ? candidate : undefined;
}

export function normalizeReplySubject(subject: string): string {
  const clean = sanitizeHeader(subject);
  return /^re\s*:/i.test(clean) ? clean : `Re: ${clean}`.trim();
}

export function appendReplyReference(references: string, messageId: string): string {
  const existing = sanitizeHeader(references);
  const parent = sanitizeHeader(messageId);
  if (!existing) return parent;
  return existing.split(/\s+/).includes(parent) ? existing : `${existing} ${parent}`;
}

/** Derive one-recipient Gmail and RFC threading fields without guessing missing source data. */
export function deriveReplyDraft(
  source: gmail_v1.Schema$Message,
  parentMessageId: string,
): GmailReplyDraft {
  const replyTo = messageHeader(source, "Reply-To");
  const from = messageHeader(source, "From");
  const recipientSource = replyTo || from;
  const to = extractFirstMailbox(recipientSource);
  if (!to) {
    const sourceName = replyTo ? "Reply-To" : "Reply-To or From";
    throw new GmailReplyDerivationError(
      `Cannot reply to Gmail message ${sanitizeHeader(parentMessageId)}: it has no valid ${sourceName} mailbox.`,
    );
  }

  const inReplyTo = sanitizeHeader(messageHeader(source, "Message-ID"));
  if (!inReplyTo) {
    throw new GmailReplyDerivationError(
      `Cannot reply to Gmail message ${sanitizeHeader(parentMessageId)}: it has no Message-ID header.`,
    );
  }

  const threadId = sanitizeHeader(source.threadId ?? "");
  if (!threadId) {
    throw new GmailReplyDerivationError(
      `Cannot reply to Gmail message ${sanitizeHeader(parentMessageId)}: it has no Gmail thread ID.`,
    );
  }

  return {
    to,
    subject: normalizeReplySubject(messageHeader(source, "Subject")),
    threadId,
    inReplyTo,
    references: appendReplyReference(messageHeader(source, "References"), inReplyTo),
    sourceFrom: sanitizeHeader(from),
    sourceDate: sanitizeHeader(messageHeader(source, "Date")),
  };
}
