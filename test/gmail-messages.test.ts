import { describe, expect, it } from "vitest";
import {
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
    });
  });
});
