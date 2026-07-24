/**
 * doug command aliases — familiar names from other tools mapped onto doug's own.
 *
 * /clear → a fresh session, matching what /clear does in Claude Code (and the
 * built-in /new here). It's a plain alias: no parent linkage, no carried
 * context — a clean slate.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Start a fresh session (alias for /new)",
    handler: async (_args: string, ctx: any) => {
      await ctx.newSession();
    },
  });
}
