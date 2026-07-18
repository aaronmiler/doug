/**
 * doug flip-flop detector — catches spray-and-pray debug loops.
 *
 * Pattern: edit F → run C → edit F → run C → edit F (same file, with the same
 * command re-run between edits). Before the 3rd edit lands, doug checks in
 * with the human instead of continuing to guess. With no UI to ask, the edit
 * is blocked with instructions to stop and lay out the options.
 *
 * A new user prompt resets all tracking — the human steering means the loop
 * is already broken.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

let USER = "the user";
try {
  const profilePath = join(process.env.DOUG_HOME ?? join(homedir(), ".doug"), "agent", "profile.json");
  USER = JSON.parse(readFileSync(profilePath, "utf8")).name?.trim() || USER;
} catch {}

const MAX_GAP_COMMANDS = 50;
const MAX_TRACKED_FILES = 200;

type FileState = {
  /** Commands run between the previous two edits to this file. */
  prevGap: Set<string> | null;
  /** Commands run since the most recent edit to this file. */
  currentGap: Set<string>;
};

export default function (pi: ExtensionAPI) {
  const files = new Map<string, FileState>();

  pi.on("input", async () => {
    files.clear();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      const command = (event.input.command ?? "").trim().replace(/\s+/g, " ");
      if (!command) return;
      for (const state of files.values()) {
        if (state.currentGap.size < MAX_GAP_COMMANDS) state.currentGap.add(command);
      }
      return;
    }

    if (!isToolCallEventType("edit", event) && !isToolCallEventType("write", event)) return;
    const path = event.input.path;
    if (!path) return;
    const key = resolve(path);

    const state = files.get(key);
    if (!state) {
      if (files.size >= MAX_TRACKED_FILES) files.clear();
      files.set(key, { prevGap: null, currentGap: new Set() });
      return;
    }

    const repeated = state.prevGap && [...state.currentGap].find((c) => state.prevGap!.has(c));
    if (!repeated) {
      state.prevGap = state.currentGap;
      state.currentGap = new Set();
      return;
    }

    // 3rd edit to the same file with the same command re-run between edits.
    files.delete(key);
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Flip-flop check: this is the 3rd edit to ${path} with \`${repeated}\` re-run after each edit — that looks like guess-and-check debugging, and there is no UI to ask ${USER}. Stop editing this file; summarize what you tried, what each attempt ruled out, and 2-3 candidate approaches, then wait for ${USER} to choose.`,
      };
    }
    const keepGoing = await ctx.ui.confirm(
      "doug flip-flop check",
      `3rd edit to ${path} in a row, re-running the same command each time:\n\n${repeated}\n\nThis can look like guess-and-check debugging. Let doug keep going?`,
    );
    if (!keepGoing) {
      return {
        block: true,
        reason: `${USER} paused this edit loop on ${path}. Do not edit it again yet: summarize what you tried, what each attempt ruled out, and 2-3 candidate approaches, then let ${USER} choose the direction.`,
      };
    }
  });
}
