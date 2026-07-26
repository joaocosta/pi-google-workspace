import { describe, expect, it } from "vitest";
import {
  buildPlainTextMessage,
  encodeBase64Url,
  sanitizeHeader,
} from "../src/gmail/mail.js";

describe("Gmail plain-text message builder", () => {
  it("builds optional reply and recipient headers with an exact body boundary", () => {
    const message = buildPlainTextMessage({
      to: ["one@example.test", "two@example.test"],
      cc: ["copy@example.test"],
      bcc: ["hidden@example.test"],
      subject: "Synthetic subject",
      body: "First line\n\nUnicode: Olá 🌍",
      inReplyTo: "<parent@example.test>",
      references: "<root@example.test> <parent@example.test>",
    });

    expect(message).toBe(
      [
        "To: one@example.test, two@example.test",
        "Cc: copy@example.test",
        "Bcc: hidden@example.test",
        "Subject: Synthetic subject",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        "In-Reply-To: <parent@example.test>",
        "References: <root@example.test> <parent@example.test>",
        "",
        "First line\n\nUnicode: Olá 🌍",
      ].join("\r\n"),
    );
  });

  it("preserves an empty body and omits absent optional headers", () => {
    const message = buildPlainTextMessage({
      to: ["reader@example.test"],
      subject: "Empty",
      body: "",
    });

    expect(message).not.toContain("\r\nCc:");
    expect(message).not.toContain("\r\nBcc:");
    expect(message).toMatch(/Content-Transfer-Encoding: 8bit\r\n\r\n$/);
  });

  it("collapses CR/LF in every caller-controlled header value", () => {
    const message = buildPlainTextMessage({
      to: ["reader@example.test\r\nX-To: injected"],
      cc: ["copy@example.test\nX-Cc: injected"],
      bcc: ["hidden@example.test\rX-Bcc: injected"],
      subject: "Hello\r\nX-Subject: injected",
      body: "Body",
      inReplyTo: "<parent>\nX-Reply: injected",
      references: "<root>\r\nX-References: injected",
    });

    for (const injected of ["X-To", "X-Cc", "X-Bcc", "X-Subject", "X-Reply", "X-References"]) {
      expect(message).not.toContain(`\r\n${injected}:`);
    }
    expect(sanitizeHeader(" safe\r\n value ")).toBe("safe  value");
  });

  it("base64url encodes the complete UTF-8 message without padding", () => {
    const source = "Subject: Olá 🌍\r\n\r\nCorpo";
    const encoded = encodeBase64Url(source);
    const decoded = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );

    expect(encoded).not.toMatch(/[+/=]/);
    expect(decoded).toBe(source);
  });
});
