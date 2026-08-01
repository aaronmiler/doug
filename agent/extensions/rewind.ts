/**
 * doug /rewind — discard the last turn from context, not from disk.
 *
 * The failure this exists for: mid-task in auto mode, the user floats "what if
 * we used X?" as a thought, doug executes it, and now the thread carries X as
 * established direction. Undoing the *files* is easy; the expensive part is
 * arguing the conversation back out of a path it already committed to.
 *
 * /rewind moves the session leaf back to before the last user message, so the
 * bad branch is simply gone from context — nothing to reframe, nothing to talk
 * doug out of. History is preserved in the tree (reachable via /tree), and
 * `summarize` optionally leaves behind "we considered X and moved off it" so
 * doug doesn't re-propose it ten minutes later.
 *
 * Files are deliberately NOT reverted. Rewinding past an edit would otherwise
 * leave doug's context and the working tree silently disagreeing, so instead of
 * snapshotting every edit (a lot of state for a rare action) the confirm names
 * the files the discarded branch touched and lets the user decide — they have
 * git and a working tree they already watch.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Tools whose calls mutate files on disk — the ones worth warning about when
 * their turn is discarded. Mirrors the tool names permissions.ts gates on. */
const EDIT_TOOLS = new Set(["edit", "write"]);

type Entry = any;

/** Index of the Nth-from-last user message in a root→leaf branch, or -1. */
export function findUserTurn(branch: Entry[], depth: number): number {
  let seen = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    if (++seen === depth) return i;
  }
  return -1;
}

/** Files the entries at/after `from` wrote to, in first-touched order. A tool
 * call that never produced a result still counts: it may have hit disk. */
export function editedPaths(branch: Entry[], from: number): string[] {
  const paths: string[] = [];
  for (const entry of branch.slice(from)) {
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "toolCall" || !EDIT_TOOLS.has(block.name)) continue;
      const path = block.arguments?.path;
      if (typeof path === "string" && path && !paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

/** First line of a user message, for showing what's about to be discarded. */
export function promptPreview(entry: Entry, max = 60): string {
  const content = entry?.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ")
        : "";
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("rewind", {
    description: "Discard the last turn from context (/rewind 2 for two turns back)",
    handler: async (args: string, ctx: any) => {
      const depth = Math.max(1, parseInt(args.trim(), 10) || 1);
      const branch = ctx.sessionManager.getBranch();
      const target = findUserTurn(branch, depth);
      if (target < 0) {
        ctx.ui?.notify?.(
          depth === 1 ? "Nothing to rewind — no user turn yet." : `Only ${depth - 1} user turn(s) to rewind past.`,
          "warning",
        );
        return;
      }

      const preview = promptPreview(branch[target]);
      const paths = editedPaths(branch, target);
      if (!ctx.hasUI) {
        ctx.ui?.notify?.("/rewind needs a UI to confirm.", "warning");
        return;
      }

      // Only mention files when there are some — a pure-discussion misfire is
      // the common case and should feel instant.
      const detail = paths.length
        ? `\n\nEdits to ${paths.join(", ")} stay on disk — doug will no longer know it made them.`
        : "";
      const SUMMARIZE = "Rewind + leave a note";
      const REWIND = "Rewind";
      const choice = await ctx.ui.select(
        `Rewind to before "${preview}"?${detail}`,
        [REWIND, SUMMARIZE, "Cancel"],
      );
      if (choice !== REWIND && choice !== SUMMARIZE) return;

      const result = await ctx.navigateTree(branch[target].id, {
        summarize: choice === SUMMARIZE,
        customInstructions:
          "Summarize only the direction that was explored and why it was abandoned, in one or two sentences. This is a note to your future self so you don't re-propose it.",
        label: "rewound",
      });
      if (result?.cancelled) {
        ctx.ui.notify("Rewind cancelled.", "warning");
        return;
      }

      // navigateTree doesn't restore editor text, so echo the discarded prompt
      // for the user to retype in the register they actually meant.
      ctx.ui.notify(`Rewound. Your last message was: "${preview}"`, "info");
    },
  });
}
