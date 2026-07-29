import type { gmail_v1 } from "googleapis";

export interface GmailMessageSummary {
  readonly id?: string | null;
  readonly threadId?: string | null;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly date: string;
  readonly snippet?: string | null;
}

export interface GmailAttachmentMetadata {
  readonly attachmentId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly contentDisposition?: string;
}

export interface ParsedGmailMessage extends GmailMessageSummary {
  readonly cc: string;
  readonly messageId: string;
  readonly references: string;
  readonly body: string;
  readonly attachments: readonly GmailAttachmentMetadata[];
}

export function decodeBase64Url(data?: string | null): string {
  if (!data) return "";
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

/** Look up a Gmail header without depending on Google's header-name casing. */
export function messageHeader(message: gmail_v1.Schema$Message, name: string): string {
  return message.payload?.headers?.find(
    (candidate) => candidate.name?.toLowerCase() === name.toLowerCase(),
  )?.value ?? "";
}

export function collectMimeParts(
  part: gmail_v1.Schema$MessagePart | undefined,
  mimeType: string,
  output: string[] = [],
): string[] {
  if (!part) return output;
  if (part.mimeType?.toLowerCase() === mimeType.toLowerCase() && part.body?.data) {
    output.push(decodeBase64Url(part.body.data));
  }
  for (const child of part.parts ?? []) collectMimeParts(child, mimeType, output);
  return output;
}

function partHeader(part: gmail_v1.Schema$MessagePart, name: string): string {
  return part.headers?.find(
    (candidate) => candidate.name?.toLowerCase() === name.toLowerCase(),
  )?.value ?? "";
}

function parseContentDisposition(part: gmail_v1.Schema$MessagePart): string | undefined {
  const disposition = partHeader(part, "Content-Disposition").split(";", 1)[0]?.trim();
  return disposition ? disposition.toLowerCase() : undefined;
}

/** Collect metadata for every externally stored MIME part in encounter order. */
export function collectAttachmentMetadata(
  part: gmail_v1.Schema$MessagePart | undefined,
  output: GmailAttachmentMetadata[] = [],
): GmailAttachmentMetadata[] {
  if (!part) return output;

  const attachmentId = part.body?.attachmentId;
  if (attachmentId?.trim()) {
    const sourceFilename = part.filename;
    const contentDisposition = parseContentDisposition(part);
    output.push({
      attachmentId,
      filename: sourceFilename?.trim()
        ? sourceFilename
        : `unnamed-attachment-${output.length + 1}`,
      mediaType: part.mimeType ?? "application/octet-stream",
      size: part.body?.size ?? 0,
      ...(contentDisposition ? { contentDisposition } : {}),
    });
  }

  for (const child of part.parts ?? []) collectAttachmentMetadata(child, output);
  return output;
}

export function summarizeMessage(message: gmail_v1.Schema$Message): GmailMessageSummary {
  return {
    id: message.id,
    threadId: message.threadId,
    from: messageHeader(message, "From"),
    to: messageHeader(message, "To"),
    subject: messageHeader(message, "Subject"),
    date: messageHeader(message, "Date"),
    snippet: message.snippet,
  };
}

/** Extract plain text first, then a top-level body, then raw HTML as a final fallback. */
export function parseMessage(message: gmail_v1.Schema$Message): ParsedGmailMessage {
  const plainText = collectMimeParts(message.payload, "text/plain").join("\n\n");
  const topLevelBody = decodeBase64Url(message.payload?.body?.data);
  const html = collectMimeParts(message.payload, "text/html").join("\n\n");

  return {
    ...summarizeMessage(message),
    cc: messageHeader(message, "Cc"),
    messageId: messageHeader(message, "Message-ID"),
    references: messageHeader(message, "References"),
    body: plainText || topLevelBody || html,
    attachments: collectAttachmentMetadata(message.payload),
  };
}
