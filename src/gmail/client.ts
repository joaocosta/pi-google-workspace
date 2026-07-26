import { google, type gmail_v1 } from "googleapis";
import type { OAuthClient, WorkspaceAuthService } from "../auth/oauth.js";

export interface GmailRequestOptions {
  readonly signal?: AbortSignal;
}

export interface GmailClient {
  readonly users: {
    readonly messages: {
      list(
        request: gmail_v1.Params$Resource$Users$Messages$List,
        options?: GmailRequestOptions,
      ): Promise<{ data: gmail_v1.Schema$ListMessagesResponse }>;
      get(
        request: gmail_v1.Params$Resource$Users$Messages$Get,
        options?: GmailRequestOptions,
      ): Promise<{ data: gmail_v1.Schema$Message }>;
      modify(
        request: gmail_v1.Params$Resource$Users$Messages$Modify,
        options?: GmailRequestOptions,
      ): Promise<{ data: gmail_v1.Schema$Message }>;
      trash(
        request: gmail_v1.Params$Resource$Users$Messages$Trash,
        options?: GmailRequestOptions,
      ): Promise<{ data: gmail_v1.Schema$Message }>;
      untrash(
        request: gmail_v1.Params$Resource$Users$Messages$Untrash,
        options?: GmailRequestOptions,
      ): Promise<{ data: gmail_v1.Schema$Message }>;
    };
  };
}

export type GmailClientFactory = (authClient: OAuthClient) => GmailClient;

export function createGoogleGmailClient(authClient: OAuthClient): GmailClient {
  if (!authClient.googleAuthClient) {
    throw new Error("Google API authentication transport is unavailable.");
  }
  return google.gmail({ version: "v1", auth: authClient.googleAuthClient }) as unknown as GmailClient;
}

export interface GmailClientProvider {
  getClient(): Promise<GmailClient>;
}

/** Acquire only Gmail authorization and construct the service through an injectable seam. */
export function createGmailClientProvider(
  auth: WorkspaceAuthService,
  factory: GmailClientFactory = createGoogleGmailClient,
): GmailClientProvider {
  return {
    async getClient() {
      return factory(await auth.getAuthenticatedClient("gmail"));
    },
  };
}
