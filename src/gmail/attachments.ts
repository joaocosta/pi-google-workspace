import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gmailRequestOptions, type GmailClientProvider } from "./client.js";

export const MAX_GMAIL_ATTACHMENT_BYTES = 26_214_400;
export const MAX_ATTACHMENT_FILENAME_BYTES = 240;

const DEFAULT_MEDIA_TYPE = "application/octet-stream";
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const INVALID_FILENAME_CHARACTERS = /[\\/<>:"|?*\p{Cc}]/u;
const SOURCE_INVALID_CHARACTERS = /[\\/<>:"|?*\p{Cc}]+/gu;
const WINDOWS_DEVICE_BASENAME = /^(?:con|prn|aux|nul|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))$/i;

export interface GmailAttachmentDownloadInput {
  readonly messageId: string;
  readonly attachmentId: string;
  readonly outputFilename?: string;
  readonly sourceFilename?: string;
  readonly mediaType?: string;
  readonly expectedSize?: number;
}

export interface PreparedGmailAttachmentDownload {
  readonly messageId: string;
  readonly attachmentId: string;
  readonly root: string;
  readonly filename: string;
  readonly destinationPath: string;
  readonly mediaType: string;
  readonly expectedSize?: number;
}

export interface GmailAttachmentDownloadResult {
  readonly path: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sizeHuman: string;
  readonly warnings?: readonly string[];
}

export class GmailAttachmentSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailAttachmentSafetyError";
  }
}

export class GmailAttachmentDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailAttachmentDownloadError";
  }
}

export interface GmailAttachmentFileHandle {
  writeFile(data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface GmailAttachmentFileSystem {
  lstat(path: string): Promise<unknown>;
  open(path: string, flags: "wx", mode: number): Promise<GmailAttachmentFileHandle>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface GmailAttachmentDownloadDependencies {
  readonly clientProvider: GmailClientProvider;
  readonly fs?: GmailAttachmentFileSystem;
  readonly cwd?: () => string;
  readonly temporaryToken?: () => string;
}

const defaultAttachmentFileSystem: GmailAttachmentFileSystem = {
  lstat: (path) => nodeFs.lstat(path),
  open: (path, flags, mode) => nodeFs.open(path, flags, mode),
  link: (existingPath, newPath) => nodeFs.link(existingPath, newPath),
  unlink: (path) => nodeFs.unlink(path),
};

function fail(message: string): never {
  throw new GmailAttachmentSafetyError(message);
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isWindowsDeviceName(filename: string): boolean {
  const basename = (filename.split(".", 1)[0] ?? "").replace(/[. ]+$/g, "");
  return WINDOWS_DEVICE_BASENAME.test(basename);
}

function validateExplicitFilename(filename: unknown): string {
  if (typeof filename !== "string" || !filename) {
    fail("outputFilename must be a non-blank filename.");
  }
  if (
    filename === "." ||
    filename === ".." ||
    filename.startsWith(".") ||
    filename.endsWith(".") ||
    filename.endsWith(" ") ||
    filename.normalize("NFKC") !== filename ||
    isAbsolute(filename) ||
    INVALID_FILENAME_CHARACTERS.test(filename) ||
    isWindowsDeviceName(filename) ||
    utf8Length(filename) > MAX_ATTACHMENT_FILENAME_BYTES
  ) {
    fail("outputFilename must be one safe filename in the current directory.");
  }
  return filename;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Length(character);
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function boundedSourceFilename(filename: string): string {
  if (utf8Length(filename) <= MAX_ATTACHMENT_FILENAME_BYTES) return filename;

  const extensionMatch = filename.match(/(\.[A-Za-z0-9]{1,16})$/);
  const extension = extensionMatch?.[1] ?? "";
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  const boundedStem = truncateUtf8(stem, MAX_ATTACHMENT_FILENAME_BYTES - utf8Length(extension))
    .replace(/[. ]+$/g, "");
  return `${boundedStem}${extension}`;
}

function fallbackFilename(messageId: string, attachmentId: string): string {
  const digest = createHash("sha256")
    .update(messageId)
    .update("\0")
    .update(attachmentId)
    .digest("hex")
    .slice(0, 12);
  return `attachment-${digest}.bin`;
}

export function sanitizeAttachmentSourceFilename(
  sourceFilename: string | undefined,
  messageId: string,
  attachmentId: string,
): string {
  if (sourceFilename !== undefined && typeof sourceFilename !== "string") {
    fail("sourceFilename must be a string when supplied.");
  }

  let filename = (sourceFilename ?? "")
    .normalize("NFKC")
    .replace(SOURCE_INVALID_CHARACTERS, "-")
    .replace(/^[. ]+/g, "")
    .replace(/[. ]+$/g, "");

  if (!/[\p{L}\p{N}]/u.test(filename)) return fallbackFilename(messageId, attachmentId);
  if (isWindowsDeviceName(filename)) filename = `attachment-${filename}`;
  filename = boundedSourceFilename(filename).replace(/[. ]+$/g, "");

  if (!filename || filename.startsWith(".") || isWindowsDeviceName(filename)) {
    return fallbackFilename(messageId, attachmentId);
  }
  return filename;
}

function validateId(value: unknown, label: "messageId" | "attachmentId"): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must not be blank.`);
  return value.trim();
}

function validateMediaType(value: unknown): string {
  if (value === undefined) return DEFAULT_MEDIA_TYPE;
  if (
    typeof value !== "string" ||
    utf8Length(value) > 255 ||
    !MEDIA_TYPE_PATTERN.test(value)
  ) {
    fail("mediaType must be a valid MIME type without parameters.");
  }
  return value;
}

function validateExpectedSize(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("expectedSize must be a non-negative integer.");
  }
  if (value > MAX_GMAIL_ATTACHMENT_BYTES) {
    fail("Attachment exceeds the 25 MiB decoded-size limit.");
  }
  return value;
}

/** Validate all caller hints and derive one destination from an already captured absolute root. */
export function prepareGmailAttachmentDownload(
  input: GmailAttachmentDownloadInput,
  invocationRoot: string,
): PreparedGmailAttachmentDownload {
  if (!isAbsolute(invocationRoot)) fail("Attachment invocation root must be absolute.");
  const root = resolve(invocationRoot);
  const messageId = validateId(input.messageId, "messageId");
  const attachmentId = validateId(input.attachmentId, "attachmentId");
  const filename = input.outputFilename !== undefined
    ? validateExplicitFilename(input.outputFilename)
    : sanitizeAttachmentSourceFilename(input.sourceFilename, messageId, attachmentId);
  const destinationPath = join(root, filename);
  const destinationRelative = relative(root, destinationPath);
  if (!destinationRelative || destinationRelative.startsWith(`..${sep}`) || isAbsolute(destinationRelative)) {
    fail("Attachment destination must remain in the current directory.");
  }

  const expectedSize = validateExpectedSize(input.expectedSize);
  return {
    messageId,
    attachmentId,
    root,
    filename,
    destinationPath,
    mediaType: validateMediaType(input.mediaType),
    ...(expectedSize === undefined ? {} : { expectedSize }),
  };
}

function decodedBase64UrlLength(data: string): number {
  const unpadded = data.replace(/=+$/, "");
  return Math.floor((unpadded.length * 6) / 8);
}

/** Strictly decode Gmail base64url data as binary and enforce returned and actual sizes. */
export function decodeGmailAttachmentData(data: unknown, returnedSize?: unknown): Buffer {
  if (typeof data !== "string" || !data) fail("Gmail attachment response data is missing.");

  const paddingIndex = data.indexOf("=");
  const unpadded = paddingIndex === -1 ? data : data.slice(0, paddingIndex);
  const padding = paddingIndex === -1 ? "" : data.slice(paddingIndex);
  const remainder = unpadded.length % 4;
  const validPadding = padding === "" ||
    (padding === "=" && remainder === 3 && data.length % 4 === 0) ||
    (padding === "==" && remainder === 2 && data.length % 4 === 0);

  if (!/^[A-Za-z0-9_-]+$/.test(unpadded) || remainder === 1 || !validPadding) {
    fail("Gmail attachment response data is not valid base64url.");
  }

  if (returnedSize !== undefined && returnedSize !== null) {
    if (
      typeof returnedSize !== "number" ||
      !Number.isSafeInteger(returnedSize) ||
      returnedSize < 0
    ) {
      fail("Gmail attachment response size is invalid.");
    }
    if (returnedSize > MAX_GMAIL_ATTACHMENT_BYTES) {
      fail("Attachment exceeds the 25 MiB decoded-size limit.");
    }
  }

  if (decodedBase64UrlLength(data) > MAX_GMAIL_ATTACHMENT_BYTES) {
    fail("Attachment exceeds the 25 MiB decoded-size limit.");
  }

  const bytes = Buffer.from(unpadded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const canonical = bytes.toString("base64url");
  if (canonical !== unpadded) fail("Gmail attachment response data is not valid base64url.");
  if (bytes.length > MAX_GMAIL_ATTACHMENT_BYTES) {
    fail("Attachment exceeds the 25 MiB decoded-size limit.");
  }
  if (returnedSize !== undefined && returnedSize !== null && returnedSize !== bytes.length) {
    fail("Gmail attachment response size does not match decoded data.");
  }
  return bytes;
}

export function formatIecBytes(sizeBytes: number): string {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_GMAIL_ATTACHMENT_BYTES) {
    fail("Attachment result size is invalid.");
  }
  if (sizeBytes < 1024) return `${String(sizeBytes)} B`;
  const units = ["KiB", "MiB"] as const;
  let value = sizeBytes / 1024;
  let unit: (typeof units)[number] = units[0];
  if (value >= 1024) {
    value /= 1024;
    unit = units[1];
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${String(rounded)} ${unit}`;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new GmailAttachmentDownloadError("Attachment download was cancelled.");
}

async function destinationMustNotExist(
  fs: GmailAttachmentFileSystem,
  destinationPath: string,
): Promise<void> {
  try {
    await fs.lstat(destinationPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw new GmailAttachmentDownloadError("Could not safely inspect the attachment destination.");
  }
  throw new GmailAttachmentDownloadError("Attachment destination already exists.");
}

function createTemporaryFilename(tokenFactory: () => string): string {
  const token = tokenFactory();
  if (!/^[a-f0-9]{16,64}$/i.test(token)) {
    throw new GmailAttachmentDownloadError("Could not create a safe temporary attachment file.");
  }
  return `.gws-gmail-attachment-${token}.tmp`;
}

/** Retrieve exactly one explicit attachment and publish it through an exclusive hard link. */
export async function downloadGmailAttachment(
  input: GmailAttachmentDownloadInput,
  dependencies: GmailAttachmentDownloadDependencies,
  signal?: AbortSignal,
): Promise<GmailAttachmentDownloadResult> {
  const invocationRoot = resolve((dependencies.cwd ?? process.cwd)());
  const prepared = prepareGmailAttachmentDownload(input, invocationRoot);
  const fs = dependencies.fs ?? defaultAttachmentFileSystem;

  throwIfCancelled(signal);
  await destinationMustNotExist(fs, prepared.destinationPath);
  throwIfCancelled(signal);

  let response: { data: { data?: string | null; size?: number | null } };
  try {
    const client = await dependencies.clientProvider.getClient();
    throwIfCancelled(signal);
    response = await client.users.messages.attachments.get(
      {
        userId: "me",
        messageId: prepared.messageId,
        id: prepared.attachmentId,
      },
      gmailRequestOptions(signal),
    );
  } catch (error) {
    if (error instanceof GmailAttachmentDownloadError) throw error;
    throwIfCancelled(signal);
    throw new GmailAttachmentDownloadError("Could not retrieve the Gmail attachment.");
  }

  throwIfCancelled(signal);
  const bytes = decodeGmailAttachmentData(response.data.data, response.data.size);
  throwIfCancelled(signal);

  const temporaryFilename = createTemporaryFilename(
    dependencies.temporaryToken ?? (() => randomBytes(16).toString("hex")),
  );
  const temporaryPath = join(prepared.root, temporaryFilename);
  let handle: GmailAttachmentFileHandle | undefined;
  let temporaryCreated = false;
  let closed = false;
  let published = false;
  let stage: "open" | "write" | "sync" | "close" | "link" = "open";

  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    stage = "write";
    await handle.writeFile(bytes);
    throwIfCancelled(signal);
    stage = "sync";
    await handle.sync();
    throwIfCancelled(signal);
    stage = "close";
    await handle.close();
    closed = true;
    throwIfCancelled(signal);
    stage = "link";
    await fs.link(temporaryPath, prepared.destinationPath);
    published = true;

    try {
      await fs.unlink(temporaryPath);
      temporaryCreated = false;
      return buildGmailAttachmentResult(prepared, bytes.length);
    } catch {
      return buildGmailAttachmentResult(prepared, bytes.length, temporaryFilename);
    }
  } catch (error) {
    if (handle && !closed) {
      try {
        await handle.close();
      } catch {
        // Best effort only; the temporary name is still removed below.
      }
    }
    if (temporaryCreated && !published) {
      try {
        await fs.unlink(temporaryPath);
      } catch {
        // Best-effort pre-publication cleanup must not expose internal paths.
      }
    }

    if (error instanceof GmailAttachmentDownloadError) throw error;
    throwIfCancelled(signal);
    if (stage === "link" && errorCode(error) === "EEXIST") {
      throw new GmailAttachmentDownloadError("Attachment destination already exists.");
    }
    throw new GmailAttachmentDownloadError("Could not publish the Gmail attachment safely.");
  }
}

export function buildGmailAttachmentResult(
  prepared: PreparedGmailAttachmentDownload,
  sizeBytes: number,
  temporaryCleanupFilename?: string,
): GmailAttachmentDownloadResult {
  let warnings: readonly string[] | undefined;
  if (temporaryCleanupFilename !== undefined) {
    if (
      !temporaryCleanupFilename ||
      temporaryCleanupFilename === "." ||
      temporaryCleanupFilename === ".." ||
      utf8Length(temporaryCleanupFilename) > MAX_ATTACHMENT_FILENAME_BYTES ||
      isAbsolute(temporaryCleanupFilename) ||
      INVALID_FILENAME_CHARACTERS.test(temporaryCleanupFilename)
    ) {
      fail("Temporary cleanup filename is invalid.");
    }
    warnings = [`./${temporaryCleanupFilename}`];
  }

  return {
    path: `./${prepared.filename}`,
    mediaType: prepared.mediaType,
    sizeBytes,
    sizeHuman: formatIecBytes(sizeBytes),
    ...(warnings ? { warnings } : {}),
  };
}
