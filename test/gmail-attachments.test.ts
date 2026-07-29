import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGmailAttachmentResult,
  decodeGmailAttachmentData,
  formatIecBytes,
  MAX_ATTACHMENT_FILENAME_BYTES,
  MAX_GMAIL_ATTACHMENT_BYTES,
  prepareGmailAttachmentDownload,
  sanitizeAttachmentSourceFilename,
} from "../src/gmail/attachments.js";

const root = resolve("/synthetic-attachment-root");
const identifiers = { messageId: "message-secret-value", attachmentId: "attachment-secret-value" };

function prepare(overrides: Partial<Parameters<typeof prepareGmailAttachmentDownload>[0]> = {}) {
  return prepareGmailAttachmentDownload(
    { ...identifiers, sourceFilename: "report.pdf", ...overrides },
    root,
  );
}

describe("Gmail attachment input preparation", () => {
  it("prepares trimmed explicit IDs and bounded default result metadata beneath the captured root", () => {
    const prepared = prepare({
      messageId: "  message-id  ",
      attachmentId: " attachment-id ",
      sourceFilename: undefined,
      outputFilename: "chosen.bin",
    });

    expect(prepared).toMatchObject({
      messageId: "message-id",
      attachmentId: "attachment-id",
      root,
      filename: "chosen.bin",
      destinationPath: resolve(root, "chosen.bin"),
      mediaType: "application/octet-stream",
    });
    expect(buildGmailAttachmentResult(prepared, 1536)).toEqual({
      path: "./chosen.bin",
      mediaType: "application/octet-stream",
      sizeBytes: 1536,
      sizeHuman: "1.5 KiB",
    });
    expect(buildGmailAttachmentResult(prepared, 1536, ".gws-fixture.tmp").warnings)
      .toEqual(["./.gws-fixture.tmp"]);
    expect(() => buildGmailAttachmentResult(prepared, 1536, "../unsafe.tmp"))
      .toThrow("cleanup filename is invalid");
  });

  it.each([
    [{ messageId: " " }, "messageId must not be blank"],
    [{ attachmentId: "\t" }, "attachmentId must not be blank"],
    [{ expectedSize: -1 }, "expectedSize must be a non-negative integer"],
    [{ expectedSize: 1.5 }, "expectedSize must be a non-negative integer"],
    [{ expectedSize: Number.MAX_SAFE_INTEGER + 1 }, "expectedSize must be a non-negative integer"],
    [{ expectedSize: MAX_GMAIL_ATTACHMENT_BYTES + 1 }, "25 MiB"],
    [{ mediaType: "text/plain; charset=utf-8" }, "valid MIME type"],
    [{ mediaType: "not-a-type" }, "valid MIME type"],
  ] as const)("rejects invalid request hints before later side effects: %j", (overrides, message) => {
    expect(() => prepare(overrides)).toThrow(message);
  });

  it("accepts the exact preflight limit and preserves a valid media-type hint", () => {
    expect(prepare({ expectedSize: MAX_GMAIL_ATTACHMENT_BYTES, mediaType: "application/pdf" }))
      .toMatchObject({ expectedSize: MAX_GMAIL_ATTACHMENT_BYTES, mediaType: "application/pdf" });
  });

  it.each([
    "../escape.txt",
    "folder/file.txt",
    "folder\\file.txt",
    "/absolute.txt",
    "C:\\absolute.txt",
    ".env",
    ".",
    "..",
    "CON",
    "nul.txt",
    "CON .txt",
    "COM¹.log",
    "report.",
    "report ",
    "bad:name.txt",
    "．env",
  ])("rejects an unsafe explicit caller filename without rewriting it: %s", (outputFilename) => {
    expect(() => prepare({ outputFilename })).toThrow(
      "outputFilename must be one safe filename in the current directory",
    );
  });

  it("rejects overlong explicit names and relative invocation roots", () => {
    expect(() => prepare({ outputFilename: `${"a".repeat(241)}.txt` })).toThrow("safe filename");
    expect(() => prepareGmailAttachmentDownload(identifiers, "relative/root")).toThrow(
      "invocation root must be absolute",
    );
  });
});

describe("Gmail attachment source-name policy", () => {
  it.each([
    ["../../report?.pdf. ", "-..-report-.pdf"],
    ["folder\\nested/report.txt", "folder-nested-report.txt"],
    [".env", "env"],
    ["CON.txt", "attachment-CON.txt"],
    ["CON .txt", "attachment-CON .txt"],
    ["COM¹.log", "attachment-COM1.log"],
    ["nul", "attachment-nul"],
    ["control\u0000name.bin", "control-name.bin"],
  ])("sanitizes untrusted cross-platform source names: %j", (source, expected) => {
    expect(sanitizeAttachmentSourceFilename(source, identifiers.messageId, identifiers.attachmentId))
      .toBe(expected);
  });

  it("uses a deterministic digest fallback without exposing either raw ID", () => {
    const first = sanitizeAttachmentSourceFilename("///***", identifiers.messageId, identifiers.attachmentId);
    const second = sanitizeAttachmentSourceFilename("", identifiers.messageId, identifiers.attachmentId);
    const different = sanitizeAttachmentSourceFilename("", identifiers.messageId, "different-attachment");

    expect(first).toBe(second);
    expect(first).toMatch(/^attachment-[a-f0-9]{12}\.bin$/);
    expect(first).not.toContain(identifiers.messageId);
    expect(first).not.toContain(identifiers.attachmentId);
    expect(different).not.toBe(first);
  });

  it("bounds UTF-8 filename bytes while preserving a practical safe extension", () => {
    const filename = sanitizeAttachmentSourceFilename(
      `${"é".repeat(300)}.pdf`,
      identifiers.messageId,
      identifiers.attachmentId,
    );

    expect(Buffer.byteLength(filename)).toBeLessThanOrEqual(MAX_ATTACHMENT_FILENAME_BYTES);
    expect(filename).toMatch(/\.pdf$/);
    expect(prepare({ sourceFilename: `${"é".repeat(300)}.pdf` }).destinationPath)
      .toBe(resolve(root, filename));
  });
});

describe("Gmail attachment binary decoding and result bounds", () => {
  it("strictly decodes arbitrary binary bytes without a UTF-8 transformation", () => {
    const original = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x0a]);
    const decoded = decodeGmailAttachmentData(original.toString("base64url"), original.length);

    expect(decoded.equals(original)).toBe(true);
  });

  it.each([
    undefined,
    null,
    "",
    "A",
    "AA+_",
    "AA/=",
    "AA=",
    "AAA==",
    "AAAA=",
    "AA===",
    "AB",
  ])("rejects missing, malformed-padding, or non-canonical payload data: %j", (data) => {
    expect(() => decodeGmailAttachmentData(data)).toThrow(/missing|valid base64url/);
  });

  it("accepts canonical optional base64url padding", () => {
    expect(decodeGmailAttachmentData("AA==")).toEqual(Buffer.from([0]));
    expect(decodeGmailAttachmentData("AAA=")).toEqual(Buffer.from([0, 0]));
  });

  it("enforces the exact decoded ceiling and rejects one byte over", () => {
    const atLimit = Buffer.alloc(MAX_GMAIL_ATTACHMENT_BYTES);
    const overLimit = Buffer.alloc(MAX_GMAIL_ATTACHMENT_BYTES + 1);

    expect(decodeGmailAttachmentData(atLimit.toString("base64url"), atLimit.length).length)
      .toBe(MAX_GMAIL_ATTACHMENT_BYTES);
    expect(() => decodeGmailAttachmentData(overLimit.toString("base64url"))).toThrow("25 MiB");
  });

  it("rejects invalid, excessive, and mismatched Gmail-returned sizes", () => {
    const encoded = Buffer.from("three").toString("base64url");
    expect(() => decodeGmailAttachmentData(encoded, -1)).toThrow("response size is invalid");
    expect(() => decodeGmailAttachmentData(encoded, MAX_GMAIL_ATTACHMENT_BYTES + 1)).toThrow("25 MiB");
    expect(() => decodeGmailAttachmentData(encoded, 4)).toThrow("does not match decoded data");
  });

  it("tolerates an expected-size hint mismatch and derives all result sizes from actual bytes", () => {
    const prepared = prepare({ expectedSize: 999, mediaType: "application/x-synthetic" });
    const actual = decodeGmailAttachmentData(Buffer.from("three").toString("base64url"));

    expect(buildGmailAttachmentResult(prepared, actual.length)).toEqual({
      path: "./report.pdf",
      mediaType: "application/x-synthetic",
      sizeBytes: 5,
      sizeHuman: "5 B",
    });
    expect(formatIecBytes(MAX_GMAIL_ATTACHMENT_BYTES)).toBe("25 MiB");
  });

  it("keeps malicious source values and attachment bytes out of errors and metadata", () => {
    const malicious = "/private/fixture-secret/../../payload.bin";
    let message = "";
    try {
      prepare({ outputFilename: malicious });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(malicious);

    const bytes = Buffer.from("fixture-byte-secret");
    const result = buildGmailAttachmentResult(prepare({ sourceFilename: "safe.bin" }), bytes.length);
    expect(JSON.stringify(result)).not.toContain("fixture-byte-secret");
  });
});
