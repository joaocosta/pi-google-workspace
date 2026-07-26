import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkspaceAppRegistry } from "./auth/apps.js";
import {
  createGoogleOAuthClient,
  createNodeLoopbackServer,
  createWorkspaceAuth,
  type LoopbackServerFactory,
  type OAuthClientFactory,
  type WorkspaceAuthService,
} from "./auth/oauth.js";
import { createTokenStore, type TokenStore } from "./auth/token-store.js";
import type { CalendarClientFactory, CalendarClientProvider } from "./calendar/client.js";
import type { CalendarTimeDependencies } from "./calendar/events.js";
import { registerCalendar } from "./calendar/index.js";
import { registerAuthCommands } from "./extension/commands.js";
import type { GmailClientFactory, GmailClientProvider } from "./gmail/client.js";
import { registerGmail } from "./gmail/index.js";

export interface GoogleWorkspaceDependencies {
  readonly tokenStore?: TokenStore;
  readonly oauthClientFactory?: OAuthClientFactory;
  readonly loopbackServerFactory?: LoopbackServerFactory;
  readonly authService?: WorkspaceAuthService;
  readonly calendarClientFactory?: CalendarClientFactory;
  readonly calendarClientProvider?: CalendarClientProvider;
  readonly calendarTime?: CalendarTimeDependencies;
  readonly gmailClientFactory?: GmailClientFactory;
  readonly gmailClientProvider?: GmailClientProvider;
}

/** Create an injectable extension factory while keeping this module a composition root. */
export function createGoogleWorkspaceExtension(
  dependencies: GoogleWorkspaceDependencies = {},
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const store = dependencies.tokenStore ?? createTokenStore();
    const apps = createWorkspaceAppRegistry(store);
    const auth =
      dependencies.authService ??
      createWorkspaceAuth({
        store,
        apps,
        oauthClientFactory: dependencies.oauthClientFactory ?? createGoogleOAuthClient,
        loopbackServerFactory: dependencies.loopbackServerFactory ?? createNodeLoopbackServer,
      });

    registerAuthCommands(pi, auth);
    registerGmail(pi, {
      auth,
      clientFactory: dependencies.gmailClientFactory,
      clientProvider: dependencies.gmailClientProvider,
    });
    registerCalendar(pi, {
      auth,
      clientFactory: dependencies.calendarClientFactory,
      clientProvider: dependencies.calendarClientProvider,
      time: dependencies.calendarTime,
    });
  };
}

export default createGoogleWorkspaceExtension();
