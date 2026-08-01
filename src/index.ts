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
import { CALENDAR_TOOL_NAMES, registerCalendar } from "./calendar/index.js";
import { registerAuthCommands } from "./extension/commands.js";
import type { GmailClientFactory, GmailClientProvider } from "./gmail/client.js";
import { GMAIL_TOOL_NAMES, registerGmail } from "./gmail/index.js";

const GOOGLE_WORKSPACE_TOOL_NAMES = [
  ...Object.values(GMAIL_TOOL_NAMES),
  ...Object.values(CALENDAR_TOOL_NAMES),
];
const GOOGLE_WORKSPACE_TOOL_NAME_SET = new Set<string>(GOOGLE_WORKSPACE_TOOL_NAMES);

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

    pi.registerFlag("gws-enabled", {
      description: "Start with Google Workspace tools enabled",
      type: "boolean",
      default: false,
    });

    let toolsEnabled = false;
    const setToolsEnabled = (enabled: boolean) => {
      const otherActiveTools = pi
        .getActiveTools()
        .filter((name) => !GOOGLE_WORKSPACE_TOOL_NAME_SET.has(name));
      pi.setActiveTools(
        enabled
          ? [...new Set([...otherActiveTools, ...GOOGLE_WORKSPACE_TOOL_NAMES])]
          : otherActiveTools,
      );
      toolsEnabled = enabled;
    };

    registerAuthCommands(pi, auth, {
      isEnabled: () => toolsEnabled,
      setEnabled: setToolsEnabled,
    });
    registerGmail(pi, {
      auth,
      ...(dependencies.gmailClientFactory
        ? { clientFactory: dependencies.gmailClientFactory }
        : {}),
      ...(dependencies.gmailClientProvider
        ? { clientProvider: dependencies.gmailClientProvider }
        : {}),
    });
    registerCalendar(pi, {
      auth,
      ...(dependencies.calendarClientFactory
        ? { clientFactory: dependencies.calendarClientFactory }
        : {}),
      ...(dependencies.calendarClientProvider
        ? { clientProvider: dependencies.calendarClientProvider }
        : {}),
      ...(dependencies.calendarTime ? { time: dependencies.calendarTime } : {}),
    });

    // State is deliberately in-memory only and reset for every newly bound session.
    // The CLI flag supplies an explicit initial state for one-shot/headless use.
    pi.on("session_start", () => {
      setToolsEnabled(pi.getFlag("gws-enabled") === true);
    });
  };
}

export default createGoogleWorkspaceExtension();
