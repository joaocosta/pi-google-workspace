import type { gmail_v1 } from "googleapis";

export function encodeFixture(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export const nestedMultipartMessage: gmail_v1.Schema$Message = {
  id: "msg-synthetic-1",
  threadId: "thread-synthetic-1",
  snippet: "Synthetic snippet",
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "fRoM", value: "Sender <sender@example.test>" },
      { name: "TO", value: "reader@example.test" },
      { name: "Cc", value: "copy@example.test" },
      { name: "subject", value: "Synthetic subject" },
      { name: "DATE", value: "Thu, 01 Jan 2026 12:00:00 +0000" },
      { name: "Message-ID", value: "<synthetic-1@example.test>" },
      { name: "References", value: "<parent@example.test>" },
    ],
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/html", body: { data: encodeFixture("<p>HTML fallback</p>") } },
          { mimeType: "text/plain", body: { data: encodeFixture("First plain section") } },
        ],
      },
      { mimeType: "text/plain", body: { data: encodeFixture("Second plain section") } },
      {
        filename: "report.pdf",
        mimeType: "application/pdf",
        headers: [{ name: "Content-Disposition", value: "attachment; filename=report.pdf" }],
        body: { attachmentId: "attachment-report", size: 12 },
      },
      {
        mimeType: "multipart/related",
        parts: [
          {
            filename: "inline-image.png",
            mimeType: "image/png",
            headers: [{ name: "cOnTeNt-DiSpOsItIoN", value: "Inline; filename=inline-image.png" }],
            body: { attachmentId: "attachment-inline", size: 34 },
          },
          {
            mimeType: "multipart/mixed",
            parts: [
              {
                filename: "   ",
                body: { attachmentId: "attachment-unnamed" },
              },
              {
                filename: "not-external.txt",
                mimeType: "text/plain",
                body: { attachmentId: "   ", size: 5 },
              },
            ],
          },
        ],
      },
    ],
  },
};

export const htmlOnlyMessage: gmail_v1.Schema$Message = {
  id: "msg-html",
  payload: {
    mimeType: "multipart/alternative",
    parts: [{ mimeType: "text/html", body: { data: encodeFixture("<p>Only HTML</p>") } }],
  },
};

export const topLevelBodyMessage: gmail_v1.Schema$Message = {
  id: "msg-top-level",
  payload: { mimeType: "text/plain", body: { data: encodeFixture("Top-level body") } },
};
