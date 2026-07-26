import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ConfirmationContext = Pick<ExtensionContext, "hasUI" | "ui">;

/** Interactive mutations require confirmation; headless callers own explicit consent. */
export async function confirmMutation(
  ctx: ConfirmationContext,
  title: string,
  message: string,
): Promise<boolean> {
  return ctx.hasUI ? ctx.ui.confirm(title, message) : true;
}
