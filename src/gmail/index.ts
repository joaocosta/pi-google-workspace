import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sanitizeAuthError, type WorkspaceAuthService } from "../auth/oauth.js";
import { confirmMutation } from "../extension/confirmation.js";
import {
  createGmailClientProvider,
  type GmailClientFactory,
  type GmailClientProvider,
} from "./client.js";
import { buildPlainTextMessage, encodeBase64Url, sanitizeHeader } from "./mail.js";
import { parseMessage, summarizeMessage } from "./messages.js";

export interface GmailDependencies {
  readonly auth: WorkspaceAuthService;
  readonly clientFactory?: GmailClientFactory;
  readonly clientProvider?: GmailClientProvider;
}

let gmailMutationQueue = Promise.resolve();

async function serializeGmailMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const previous = gmailMutationQueue;
  let release!: () => void;
  gmailMutationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await mutation();
  } finally {
    release();
  }
}

function failure(error: unknown, action: string) {
  const safe = sanitizeAuthError(
    error,
    `Could not ${action}. Run /gws-login gmail if Gmail authentication has expired.`,
  );
  return {
    content: [{ type: "text" as const, text: safe.message }],
    isError: true,
    details: { app: "gmail" as const },
  };
}

export function buildGmailSearchQuery(query: string, scope: "inbox" | "all_mail" = "inbox"): string {
  const trimmed = query.trim();
  return scope === "all_mail"
    ? trimmed
    : `in:inbox -in:spam -in:trash -in:snoozed (${trimmed})`;
}

export function registerGmail(pi: ExtensionAPI, dependencies: GmailDependencies): void {
  const clients =
    dependencies.clientProvider ??
    createGmailClientProvider(dependencies.auth, dependencies.clientFactory);

  pi.registerTool({
    name: "gws_gmail_search",
    label: "Google Workspace Gmail Search",
    description:
      "Search Gmail with Gmail search syntax. Inbox scope excludes spam, trash, and snoozed messages. Read-only.",
    promptSnippet: "gws_gmail_search: search Gmail and return bounded message metadata",
    promptGuidelines: [
      "Use gws_gmail_search to find Gmail messages before reading or identifying one for a later action.",
      "Set gws_gmail_search includeSpamTrash to true only when the user explicitly asks to search spam or trash.",
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Gmail search query" }),
      maxResults: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 20, default: 10 }),
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal("inbox"), Type.Literal("all_mail")], { default: "inbox" }),
      ),
      includeSpamTrash: Type.Optional(
        Type.Boolean({
          default: false,
          description: "Only set true when the user explicitly requests spam or trash.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      if (!params.query.trim()) {
        return {
          content: [{ type: "text", text: "Gmail search query must not be blank." }],
          isError: true,
          details: { app: "gmail" as const },
        };
      }

      try {
        const client = await clients.getClient();
        const response = await client.users.messages.list(
          {
            userId: "me",
            q: buildGmailSearchQuery(params.query, params.scope),
            includeSpamTrash: params.includeSpamTrash === true,
            maxResults: Math.max(1, Math.min(params.maxResults ?? 10, 20)),
          },
          { signal },
        );
        const summaries = await Promise.all(
          (response.data.messages ?? []).map(async (message) => {
            if (!message.id) return summarizeMessage(message);
            const full = await client.users.messages.get(
              {
                userId: "me",
                id: message.id,
                format: "metadata",
                metadataHeaders: ["From", "To", "Subject", "Date"],
              },
              { signal },
            );
            const summary = summarizeMessage(full.data);
            return {
              ...summary,
              id: summary.id ?? message.id,
              threadId: summary.threadId ?? message.threadId,
            };
          }),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(summaries, null, 2) }],
          details: { app: "gmail" as const, count: summaries.length },
        };
      } catch (error) {
        return failure(error, "search Gmail");
      }
    },
  });

  pi.registerTool({
    name: "gws_gmail_read_message",
    label: "Google Workspace Gmail Read Message",
    description: "Read one Gmail message by its Gmail message ID. Read-only.",
    promptSnippet: "gws_gmail_read_message: read a Gmail message by ID",
    promptGuidelines: [
      "Use gws_gmail_read_message with an ID returned by gws_gmail_search to inspect a message body and headers.",
    ],
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: "Gmail message ID from gws_gmail_search" }),
    }),
    async execute(_toolCallId, params, signal) {
      const id = params.id.trim();
      if (!id) {
        return {
          content: [{ type: "text", text: "Gmail message ID must not be blank." }],
          isError: true,
          details: { app: "gmail" as const },
        };
      }

      try {
        const client = await clients.getClient();
        const response = await client.users.messages.get(
          { userId: "me", id, format: "full" },
          { signal },
        );
        const message = parseMessage(response.data);
        return {
          content: [{ type: "text", text: JSON.stringify(message, null, 2) }],
          details: { app: "gmail" as const, id: message.id, threadId: message.threadId },
        };
      } catch (error) {
        return failure(error, "read the Gmail message");
      }
    },
  });

  pi.registerTool({
    name: "gws_gmail_create_draft",
    label: "Google Workspace Gmail Create Draft",
    description:
      "Create a plain-text Gmail draft after explicit caller intent and interactive confirmation. The message remains a draft and is not sent.",
    promptSnippet: "gws_gmail_create_draft: create a Gmail draft, never send it",
    promptGuidelines: [
      "gws_gmail_create_draft only creates drafts; never claim an email was sent.",
      "Before using gws_gmail_create_draft, show the intended recipients, subject, and full body unless the user already explicitly provided them; headless use requires explicit caller intent.",
    ],
    parameters: Type.Object({
      to: Type.Array(Type.String(), { minItems: 1, description: "Recipient email addresses" }),
      cc: Type.Optional(Type.Array(Type.String())),
      bcc: Type.Optional(Type.Array(Type.String())),
      subject: Type.String(),
      body: Type.String({ description: "Plain-text email body" }),
      threadId: Type.Optional(Type.String({ description: "Optional Gmail thread ID" })),
      inReplyTo: Type.Optional(Type.String({ description: "Optional Message-ID reply header" })),
      references: Type.Optional(Type.String({ description: "Optional References reply header" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return serializeGmailMutation(async () => {
        try {
          const preview = [
            "Create this Gmail draft?",
            `To: ${sanitizeHeader(params.to.join(", "))}`,
            ...(params.cc?.length ? [`Cc: ${sanitizeHeader(params.cc.join(", "))}`] : []),
            ...(params.bcc?.length ? [`Bcc: ${sanitizeHeader(params.bcc.join(", "))}`] : []),
            `Subject: ${sanitizeHeader(params.subject)}`,
            "",
            params.body,
          ].join("\n");

          if (!(await confirmMutation(ctx, "Confirm Gmail draft", preview))) {
            return {
              content: [
                { type: "text" as const, text: "Gmail draft creation cancelled by user; nothing was sent." },
              ],
              details: { app: "gmail" as const, cancelled: true },
            };
          }

          const client = await clients.getClient();
          const raw = encodeBase64Url(buildPlainTextMessage(params));
          const response = await client.users.drafts.create(
            {
              userId: "me",
              requestBody: { message: { raw, threadId: params.threadId } },
            },
            { signal },
          );
          const draftId = response.data.id;
          const messageId = response.data.message?.id;
          return {
            content: [
              {
                type: "text" as const,
                text: `Created Gmail draft ${draftId ?? "unknown"} (message ${messageId ?? "unknown"}). It has not been sent.`,
              },
            ],
            details: {
              app: "gmail" as const,
              draftId,
              messageId,
              threadId: response.data.message?.threadId ?? params.threadId,
            },
          };
        } catch (error) {
          return failure(error, "create the Gmail draft");
        }
      });
    },
  });

  pi.registerTool({
    name: "gws_gmail_move_message",
    label: "Google Workspace Gmail Move Message",
    description:
      "Move one Gmail message to Inbox, Trash, Archive, or Spam. Moving out of Trash restores it first and unrelated labels are preserved. Execute only after an explicit user request; interactive mode requires confirmation.",
    promptSnippet:
      "gws_gmail_move_message: move one Gmail message after explicit request and confirmation",
    promptGuidelines: [
      "Use gws_gmail_move_message only when the user explicitly asks to move one Gmail message to Inbox, Trash, Archive, or Spam.",
      "Before using gws_gmail_move_message, identify the source message by sender, subject, and date and state the destination; interactive mode confirms, while headless use requires explicit caller consent.",
      "When moving multiple Gmail messages, call gws_gmail_move_message one message at a time, never in parallel.",
    ],
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: "Gmail message ID, usually from gws_gmail_search" }),
      destination: Type.Union([
        Type.Literal("inbox"),
        Type.Literal("trash"),
        Type.Literal("archive"),
        Type.Literal("spam"),
      ]),
      reason: Type.Optional(
        Type.String({ description: "Short explanation of why the message should be moved" }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const id = params.id.trim();
      if (!id) {
        return {
          content: [{ type: "text", text: "Gmail message ID must not be blank." }],
          isError: true,
          details: { app: "gmail" as const },
        };
      }

      return serializeGmailMutation(async () => {
        try {
          const client = await clients.getClient();
          const response = await client.users.messages.get(
            {
              userId: "me",
              id,
              format: "metadata",
              metadataHeaders: ["From", "Subject", "Date"],
            },
            { signal },
          );
          const message = summarizeMessage(response.data);
          const destination =
            params.destination[0].toUpperCase() + params.destination.slice(1);
          const preview = [
            `Move this Gmail message to ${destination}?`,
            `From: ${message.from}`,
            `Subject: ${message.subject}`,
            `Date: ${message.date}`,
            `ID: ${id}`,
            ...(params.reason ? [`Reason: ${params.reason}`] : []),
          ].join("\n");

          if (!(await confirmMutation(ctx, `Confirm move to ${destination}`, preview))) {
            return {
              content: [{ type: "text", text: `Move to ${destination} cancelled by user.` }],
              details: {
                app: "gmail" as const,
                cancelled: true,
                id,
                destination: params.destination,
              },
            };
          }

          const previousLabelIds = response.data.labelIds ?? [];
          let moved;
          if (params.destination === "trash") {
            moved = await client.users.messages.trash({ userId: "me", id }, { signal });
          } else {
            if (previousLabelIds.includes("TRASH")) {
              await client.users.messages.untrash({ userId: "me", id }, { signal });
            }
            const requestBody =
              params.destination === "inbox"
                ? { addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] }
                : params.destination === "spam"
                  ? { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] }
                  : { removeLabelIds: ["INBOX", "SPAM"] };
            moved = await client.users.messages.modify(
              { userId: "me", id, requestBody },
              { signal },
            );
          }

          return {
            content: [{ type: "text", text: `Moved Gmail message ${id} to ${destination}.` }],
            details: {
              app: "gmail" as const,
              id,
              threadId: moved.data.threadId,
              destination: params.destination,
              previousLabelIds,
              labelIds: moved.data.labelIds,
            },
          };
        } catch (error) {
          return failure(error, "move the Gmail message");
        }
      });
    },
  });
}
