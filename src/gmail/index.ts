import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sanitizeAuthError, type WorkspaceAuthService } from "../auth/oauth.js";
import {
  createGmailClientProvider,
  type GmailClientFactory,
  type GmailClientProvider,
} from "./client.js";
import { parseMessage, summarizeMessage } from "./messages.js";

export interface GmailDependencies {
  readonly auth: WorkspaceAuthService;
  readonly clientFactory?: GmailClientFactory;
  readonly clientProvider?: GmailClientProvider;
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
}
