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
import { registerAuthCommands } from "./extension/commands.js";

export interface GoogleWorkspaceDependencies {
  readonly tokenStore?: TokenStore;
  readonly oauthClientFactory?: OAuthClientFactory;
  readonly loopbackServerFactory?: LoopbackServerFactory;
  readonly authService?: WorkspaceAuthService;
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
  };
}

export default createGoogleWorkspaceExtension();
