import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { WORKSPACE_APP_KEYS, type WorkspaceAppKey } from "../auth/paths.js";
import {
  sanitizeAuthError,
  type LocalAuthState,
  type WorkspaceAuthService,
} from "../auth/oauth.js";

const APP_ARGUMENTS = WORKSPACE_APP_KEYS.join("|");

export interface WorkspaceToolControl {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
}

export type ClipboardWriter = (text: string) => Promise<void>;

function parseApp(argument: string): WorkspaceAppKey | undefined {
  const normalized = argument.trim().toLowerCase();
  return WORKSPACE_APP_KEYS.find((app) => app === normalized);
}

async function selectApp(
  argument: string,
  command: "login" | "logout",
  auth: WorkspaceAuthService,
  ctx: ExtensionCommandContext,
): Promise<WorkspaceAppKey | undefined> {
  const trimmed = argument.trim();
  if (trimmed) {
    const app = parseApp(trimmed);
    if (!app) ctx.ui.notify(`Usage: /gws-${command} ${APP_ARGUMENTS}`, "error");
    return app;
  }

  if (!ctx.hasUI) {
    ctx.ui.notify(`Usage: /gws-${command} ${APP_ARGUMENTS}`, "info");
    return undefined;
  }

  const labels = WORKSPACE_APP_KEYS.map((app) => `${auth.apps[app].displayName} (${app})`);
  const selected = await ctx.ui.select(`Select an app to ${command}`, labels);
  if (!selected) {
    ctx.ui.notify(`${command === "login" ? "Login" : "Logout"} cancelled.`, "info");
    return undefined;
  }
  return WORKSPACE_APP_KEYS[labels.indexOf(selected)];
}

function appStatus(displayName: string, app: WorkspaceAppKey, state: LocalAuthState): string {
  if (state === "present") return `${displayName}: authenticated`;
  if (state === "missing") return `${displayName}: not authenticated (run /gws-login ${app})`;
  return `${displayName}: authentication invalid (run /gws-login ${app})`;
}

function clientStatus(state: LocalAuthState): string {
  if (state === "present") return "Shared OAuth client: configured";
  if (state === "missing") return "Shared OAuth client: missing";
  return "Shared OAuth client: invalid or unreadable";
}

function notifySafeError(ctx: ExtensionCommandContext, error: unknown, fallback: string): void {
  ctx.ui.notify(sanitizeAuthError(error, fallback).message, "error");
}

export function registerAuthCommands(
  pi: ExtensionAPI,
  auth: WorkspaceAuthService,
  tools: WorkspaceToolControl,
  writeClipboard: ClipboardWriter = copyToClipboard,
): void {
  const completions = (prefix: string) => {
    const matches = WORKSPACE_APP_KEYS.filter((app) => app.startsWith(prefix));
    return matches.length ? matches.map((app) => ({ value: app, label: auth.apps[app].displayName })) : null;
  };

  pi.registerCommand("gws", {
    description: "Toggle Google Workspace tools, or explicitly set them: /gws [on|off]",
    getArgumentCompletions: (prefix) => {
      const matches = ["on", "off"].filter((value) => value.startsWith(prefix.trim().toLowerCase()));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler(args, ctx) {
      const setting = args.trim().toLowerCase();
      if (setting !== "" && setting !== "on" && setting !== "off") {
        ctx.ui.notify("Usage: /gws [on|off]", "error");
        return Promise.resolve();
      }

      const enabled = setting === "" ? !tools.isEnabled() : setting === "on";
      tools.setEnabled(enabled);
      ctx.ui.notify(`Google Workspace tools ${enabled ? "enabled" : "disabled"}.`, "info");
      return Promise.resolve();
    },
  });

  pi.registerCommand("gws-login", {
    description: "Authorize Gmail or Calendar for Google Workspace tools",
    getArgumentCompletions: completions,
    async handler(args, ctx) {
      const app = await selectApp(args, "login", auth, ctx);
      if (!app) return;
      try {
        await auth.login(app, async (url) => {
          try {
            await writeClipboard(url);
            ctx.ui.notify(
              `${auth.apps[app].displayName} authorization URL copied to the clipboard. Paste it into your browser.`,
              "info",
            );
          } catch {
            ctx.ui.notify(
              `Could not copy the ${auth.apps[app].displayName} authorization URL. Open it manually:\n${url}`,
              "warning",
            );
          }
        });
        ctx.ui.notify(`${auth.apps[app].displayName} authentication saved.`, "info");
      } catch (error) {
        notifySafeError(ctx, error, `Could not authenticate ${auth.apps[app].displayName}.`);
      }
    },
  });

  pi.registerCommand("gws-status", {
    description: "Show Google Workspace tool and authentication status",
    getArgumentCompletions: completions,
    async handler(args, ctx) {
      const trimmed = args.trim();
      const selected = trimmed ? parseApp(trimmed) : undefined;
      if (trimmed && !selected) {
        ctx.ui.notify(`Usage: /gws-status [${APP_ARGUMENTS}]`, "error");
        return;
      }

      const toolStatus = `Google Workspace tools: ${tools.isEnabled() ? "enabled" : "disabled"}`;
      try {
        const status = await auth.getStatus();
        const lines = [toolStatus, clientStatus(status.client)];
        const apps = selected ? [selected] : WORKSPACE_APP_KEYS;
        for (const app of apps) {
          lines.push(appStatus(auth.apps[app].displayName, app, status.apps[app]));
        }
        ctx.ui.notify(lines.join("\n"), status.client === "present" ? "info" : "warning");
      } catch (error) {
        const safe = sanitizeAuthError(
          error,
          "Could not inspect local Google Workspace authentication status.",
        );
        ctx.ui.notify(`${toolStatus}\n${safe.message}`, "error");
      }
    },
  });

  pi.registerCommand("gws-logout", {
    description: "Remove one app's local Google Workspace token",
    getArgumentCompletions: completions,
    async handler(args, ctx) {
      const app = await selectApp(args, "logout", auth, ctx);
      if (!app) return;
      const displayName = auth.apps[app].displayName;

      if (ctx.hasUI) {
        const confirmed = await ctx.ui.confirm(
          `Log out of ${displayName}?`,
          `Remove only the local ${displayName} token? The shared OAuth client and other app tokens will remain.`,
        );
        if (!confirmed) {
          ctx.ui.notify(`${displayName} logout cancelled.`, "info");
          return;
        }
      }

      try {
        await auth.logout(app);
        ctx.ui.notify(`Removed the local ${displayName} token. Run /gws-login ${app} to authenticate again.`, "info");
      } catch (error) {
        notifySafeError(ctx, error, `Could not remove the local ${displayName} token.`);
      }
    },
  });
}
