import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadGmailAttachment,
  type GmailAttachmentFileSystem,
  MAX_GMAIL_ATTACHMENT_BYTES,
} from "../src/gmail/attachments.js";
import type { GmailClient, GmailClientProvider } from "../src/gmail/client.js";

const temporaryRoots: string[] = [];
const token = "0123456789abcdef0123456789abcdef";

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-gmail-attachment-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const nativeFs: GmailAttachmentFileSystem = {
  lstat: (path) => fs.lstat(path),
  open: (path, flags, mode) => fs.open(path, flags, mode),
  link: (existingPath, newPath) => fs.link(existingPath, newPath),
  unlink: (path) => fs.unlink(path),
};

function providerFor(
  bytes: Buffer,
  responseOverrides: { data?: string | null; size?: number | null } = {},
) {
  const attachmentGet = vi.fn(async () => ({
    data: {
      data: bytes.toString("base64url"),
      size: bytes.length,
      ...responseOverrides,
    },
  }));
  const client = {
    users: { messages: { attachments: { get: attachmentGet } } },
  } as unknown as GmailClient;
  const provider: GmailClientProvider = { getClient: vi.fn(async () => client) };
  return { provider, attachmentGet };
}

async function download(
  root: string,
  provider: GmailClientProvider,
  options: {
    fs?: GmailAttachmentFileSystem;
    signal?: AbortSignal;
    cwd?: () => string;
    outputFilename?: string;
  } = {},
) {
  return downloadGmailAttachment(
    {
      messageId: " message-explicit ",
      attachmentId: " attachment-explicit ",
      sourceFilename: "source.bin",
      outputFilename: options.outputFilename ?? "download.bin",
      mediaType: "application/x-synthetic",
      expectedSize: 1,
    },
    {
      clientProvider: provider,
      ...(options.fs === undefined ? {} : { fs: options.fs }),
      cwd: options.cwd ?? (() => root),
      temporaryToken: () => token,
    },
    options.signal,
  );
}

function injectedError(code = "EIO"): Error {
  return Object.assign(new Error("fixture secret absolute /private/internal/path"), { code });
}

describe("Gmail attachment retrieval", () => {
  it("calls only the narrow attachment endpoint with both IDs and the abort signal", async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from([0, 255, 128, 65]);
    const { provider, attachmentGet } = providerFor(bytes);
    const signal = new AbortController().signal;

    const result = await download(root, provider, { signal });

    expect(attachmentGet).toHaveBeenCalledTimes(1);
    expect(attachmentGet).toHaveBeenCalledWith(
      { userId: "me", messageId: "message-explicit", id: "attachment-explicit" },
      { signal },
    );
    expect(result).toEqual({
      path: "./download.bin",
      mediaType: "application/x-synthetic",
      sizeBytes: bytes.length,
      sizeHuman: "4 B",
    });
    expect(await fs.readFile(join(root, "download.bin"))).toEqual(bytes);
    expect(await fs.readdir(root)).toEqual(["download.bin"]);
  });

  it.runIf(process.platform !== "win32")("creates the completed inode with private mode 0600", async () => {
    const root = await temporaryRoot();
    const { provider } = providerFor(Buffer.from("private bytes"));

    await download(root, provider);

    expect((await fs.stat(join(root, "download.bin"))).mode & 0o777).toBe(0o600);
  });

  it("captures cwd exactly once and keeps later work under that root", async () => {
    const root = await temporaryRoot();
    const otherRoot = await temporaryRoot();
    const { provider } = providerFor(Buffer.from("captured"));
    const cwd = vi.fn()
      .mockReturnValueOnce(root)
      .mockReturnValue(otherRoot);

    await download(root, provider, { cwd });

    expect(cwd).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(join(root, "download.bin"), "utf8")).resolves.toBe("captured");
    await expect(fs.lstat(join(otherRoot, "download.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [{ messageId: " " }, "blank"],
    [{ outputFilename: "../escape.bin" }, "safe filename"],
    [{ expectedSize: MAX_GMAIL_ATTACHMENT_BYTES + 1 }, "25 MiB"],
  ] as const)("validates input before client acquisition: %j", async (override, expected) => {
    const root = await temporaryRoot();
    const provider: GmailClientProvider = { getClient: vi.fn() };

    await expect(downloadGmailAttachment(
      { messageId: "message", attachmentId: "attachment", ...override },
      { clientProvider: provider, cwd: () => root },
    )).rejects.toThrow(expected);
    expect(provider.getClient).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("rejects existing files and symlinks before auth while preserving their targets", async () => {
    const root = await temporaryRoot();
    const target = join(root, "target.bin");
    await fs.writeFile(join(root, "download.bin"), "existing");
    await fs.writeFile(target, "target");
    await fs.symlink(target, join(root, "linked.bin"));
    const provider: GmailClientProvider = { getClient: vi.fn() };

    await expect(download(root, provider)).rejects.toThrow("destination already exists");
    await expect(download(root, provider, { outputFilename: "linked.bin" })).rejects.toThrow(
      "destination already exists",
    );
    expect(provider.getClient).not.toHaveBeenCalled();
    await expect(fs.readFile(join(root, "download.bin"), "utf8")).resolves.toBe("existing");
    await expect(fs.readFile(target, "utf8")).resolves.toBe("target");
  });

  it("sanitizes provider/API failures and cancellation without creating files", async () => {
    const root = await temporaryRoot();
    const provider: GmailClientProvider = { getClient: vi.fn(async () => { throw injectedError(); }) };

    const failure = download(root, provider);
    await expect(failure).rejects.toThrow("Could not retrieve the Gmail attachment");
    await expect(failure).rejects.not.toThrow(/fixture secret|private\/internal/);

    const controller = new AbortController();
    controller.abort();
    const cancelledProvider: GmailClientProvider = { getClient: vi.fn() };
    await expect(download(root, cancelledProvider, { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(cancelledProvider.getClient).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each([
    [{ data: null }, "data is missing"],
    [{ data: "fixture-byte-secret+" }, "valid base64url"],
    [{ data: Buffer.from("abc").toString("base64url"), size: 2 }, "does not match"],
    [{ data: Buffer.from("abc").toString("base64url"), size: MAX_GMAIL_ATTACHMENT_BYTES + 1 }, "25 MiB"],
  ] as const)("rejects invalid Gmail response data before filesystem publication: %j", async (response, message) => {
    const root = await temporaryRoot();
    const { provider } = providerFor(Buffer.from("unused"), response);

    const operation = download(root, provider);
    await expect(operation).rejects.toThrow(message);
    await expect(operation).rejects.not.toThrow("fixture-byte-secret");
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe("Gmail attachment atomic publication", () => {
  it("writes, syncs, and closes the complete bytes before hard-link publication", async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from([0, 1, 255, 128]);
    const { provider } = providerFor(bytes);
    const events: string[] = [];
    let written = Buffer.alloc(0);
    const fakeFs: GmailAttachmentFileSystem = {
      lstat: async () => { throw injectedError("ENOENT"); },
      open: async (_path, flags, mode) => {
        expect(flags).toBe("wx");
        expect(mode).toBe(0o600);
        events.push("open");
        return {
          writeFile: async (data) => { written = Buffer.from(data); events.push("write"); },
          sync: async () => { events.push("sync"); },
          close: async () => { events.push("close"); },
        };
      },
      link: async () => { expect(written).toEqual(bytes); events.push("link"); },
      unlink: async () => { events.push("unlink"); },
    };

    await download(root, provider, { fs: fakeFs });

    expect(events).toEqual(["open", "write", "sync", "close", "link", "unlink"]);
  });

  it.each(["open", "write", "sync", "close", "link"] as const)(
    "cleans temporary state and leaves no destination after a %s-stage failure",
    async (fault) => {
      const root = await temporaryRoot();
      const { provider } = providerFor(Buffer.from("complete fixture bytes"));
      const temporaryPath = join(root, `.gws-gmail-attachment-${token}.tmp`);
      let firstClose = true;
      const faultFs: GmailAttachmentFileSystem = {
        ...nativeFs,
        open: async (path, flags, mode) => {
          if (fault === "open") throw injectedError();
          const handle = await fs.open(path, flags, mode);
          return {
            writeFile: async (data) => {
              if (fault === "write") {
                await handle.writeFile(Buffer.from(data).subarray(0, 1));
                throw injectedError();
              }
              await handle.writeFile(data);
            },
            sync: async () => {
              if (fault === "sync") throw injectedError();
              await handle.sync();
            },
            close: async () => {
              if (fault === "close" && firstClose) {
                firstClose = false;
                throw injectedError();
              }
              await handle.close();
            },
          };
        },
        link: async (existingPath, newPath) => {
          if (fault === "link") throw injectedError("ENOTSUP");
          await fs.link(existingPath, newPath);
        },
      };

      const operation = download(root, provider, { fs: faultFs });
      await expect(operation).rejects.toThrow("Could not publish the Gmail attachment safely");
      await expect(operation).rejects.not.toThrow(/fixture secret|private\/internal|complete fixture bytes/);
      await expect(fs.lstat(join(root, "download.bin"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("cleans the temporary file when cancellation is observed before publication", async () => {
    const root = await temporaryRoot();
    const { provider } = providerFor(Buffer.from("cancel before link"));
    const controller = new AbortController();
    const cancellingFs: GmailAttachmentFileSystem = {
      ...nativeFs,
      open: async (path, flags, mode) => {
        const handle = await fs.open(path, flags, mode);
        return {
          writeFile: async (data) => {
            await handle.writeFile(data);
            controller.abort();
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    };

    await expect(download(root, provider, { fs: cancellingFs, signal: controller.signal }))
      .rejects.toThrow("cancelled");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("loses a destination race without overwriting the winning entry", async () => {
    const root = await temporaryRoot();
    const { provider } = providerFor(Buffer.from("download bytes"));
    const destination = join(root, "download.bin");
    const racingFs: GmailAttachmentFileSystem = {
      ...nativeFs,
      link: async (existingPath, newPath) => {
        await fs.writeFile(newPath, "race winner", { flag: "wx" });
        await fs.link(existingPath, newPath);
      },
    };

    await expect(download(root, provider, { fs: racingFs })).rejects.toThrow("destination already exists");
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("race winner");
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("fails cleanly when hard links are unsupported and never falls back to rename or copy", async () => {
    const root = await temporaryRoot();
    const { provider } = providerFor(Buffer.from("bytes"));
    const fsWithoutLinks: GmailAttachmentFileSystem = {
      ...nativeFs,
      link: async () => { throw injectedError("ENOTSUP"); },
    };

    await expect(download(root, provider, { fs: fsWithoutLinks })).rejects.toThrow("publish");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("preserves successful publication and reports only a relative temp path when cleanup fails", async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from("post-publication fixture bytes");
    const { provider } = providerFor(bytes);
    const unlinkFailureFs: GmailAttachmentFileSystem = {
      ...nativeFs,
      unlink: async () => { throw injectedError(); },
    };

    const result = await download(root, provider, { fs: unlinkFailureFs });

    expect(await fs.readFile(join(root, "download.bin"))).toEqual(bytes);
    expect(result).toEqual({
      path: "./download.bin",
      mediaType: "application/x-synthetic",
      sizeBytes: bytes.length,
      sizeHuman: "30 B",
      warnings: [`./.gws-gmail-attachment-${token}.tmp`],
    });
    const visible = JSON.stringify(result);
    expect(visible).not.toContain(root);
    expect(visible).not.toContain("post-publication fixture bytes");
  });
});
