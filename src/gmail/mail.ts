export interface PlainTextMessage {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string;
  readonly references?: string;
}

/** Prevent caller-controlled values from creating additional RFC message headers. */
export function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function addressHeader(name: string, values: readonly string[] | undefined): string | undefined {
  return values?.length ? `${name}: ${sanitizeHeader(values.join(", "))}` : undefined;
}

/** Build a UTF-8, plain-text RFC-style message suitable for Gmail's raw field. */
export function buildPlainTextMessage(message: PlainTextMessage): string {
  const headers = [
    addressHeader("To", message.to),
    addressHeader("Cc", message.cc),
    addressHeader("Bcc", message.bcc),
    `Subject: ${sanitizeHeader(message.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    message.inReplyTo ? `In-Reply-To: ${sanitizeHeader(message.inReplyTo)}` : undefined,
    message.references ? `References: ${sanitizeHeader(message.references)}` : undefined,
  ].filter((header): header is string => header !== undefined);

  return `${headers.join("\r\n")}\r\n\r\n${message.body}`;
}

export function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
