import { describe, expect, it } from "vitest";
import {
  collectAttachmentMetadata,
  collectMimeParts,
  decodeBase64Url,
  messageHeader,
  parseMessage,
  summarizeMessage,
} from "../src/gmail/messages.js";
import {
  encodeFixture,
  htmlOnlyMessage,
  nestedMultipartMessage,
  topLevelBodyMessage,
} from "./fixtures/gmail-messages.js";

describe("Gmail message parsing", () => {
  it("decodes base64url and recursively prefers all plain-text MIME parts", () => {
    expect(decodeBase64Url(encodeFixture("safe + synthetic / text"))).toBe(
      "safe + synthetic / text",
    );
    expect(collectMimeParts(nestedMultipartMessage.payload, "text/plain")).toEqual([
      "First plain section",
      "Second plain section",
    ]);
    expect(parseMessage(nestedMultipartMessage).body).toBe(
      "First plain section\n\nSecond plain section",
    );
  });

  it("collects nested, inline, and unnamed external attachment metadata", () => {
    const expected = [
      {
        attachmentId: "attachment-report",
        filename: "report.pdf",
        mediaType: "application/pdf",
        size: 12,
        contentDisposition: "attachment",
      },
      {
        attachmentId: "attachment-inline",
        filename: "inline-image.png",
        mediaType: "image/png",
        size: 34,
        contentDisposition: "inline",
      },
      {
        attachmentId: "attachment-unnamed",
        filename: "unnamed-attachment-3",
        mediaType: "application/octet-stream",
        size: 0,
      },
    ];

    expect(collectAttachmentMetadata(nestedMultipartMessage.payload)).toEqual(expected);
    expect(parseMessage(nestedMultipartMessage)).toMatchObject({
      body: "First plain section\n\nSecond plain section",
      attachments: expected,
    });
  });

  it("uses the top-level body before falling back to raw HTML", () => {
    expect(parseMessage(topLevelBodyMessage).body).toBe("Top-level body");
    expect(parseMessage(htmlOnlyMessage).body).toBe("<p>Only HTML</p>");
  });

  it("looks up headers case-insensitively and safely represents absent fields", () => {
    expect(messageHeader(nestedMultipartMessage, "from")).toBe(
      "Sender <sender@example.test>",
    );
    expect(summarizeMessage({})).toEqual({
      id: undefined,
      threadId: undefined,
      from: "",
      to: "",
      subject: "",
      date: "",
      snippet: undefined,
    });
    expect(parseMessage({ payload: {} })).toMatchObject({
      from: "",
      to: "",
      cc: "",
      subject: "",
      messageId: "",
      references: "",
      body: "",
      attachments: [],
    });
  });
});
