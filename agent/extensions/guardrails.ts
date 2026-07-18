/**
 * doug guardrails — enforces the human-task boundaries on the bash tool.
 * The human's name comes from ~/.doug/profile.json.
 *
 * Two tiers:
 *  - BLOCK: never allowed from doug (mutative git, secret reads, catastrophic
 *    deletes, sudo, prod deploys). doug prints the command for the human.
 *  - CONFIRM: allowed only with live approval (installs and other
 *    machine-level changes). Hard-blocked when there's no UI to ask.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let USER = "the user";
const DOUG_DIR = process.env.DOUG_HOME ?? join(homedir(), ".doug");
// Flat ~/.doug/profile.json is canonical; agent/profile.json is the pre-flat-layout location.
for (const p of [join(DOUG_DIR, "profile.json"), join(DOUG_DIR, "agent", "profile.json")]) {
  try {
    USER = JSON.parse(readFileSync(p, "utf8")).name?.trim() || USER;
    break;
  } catch {}
}

const HAND_OFF = `Do not retry or work around this. Print the exact command for ${USER} to run.`;

/**
 * Race modes, for headless runs (doug -p). Set by bin/doug from --push /
 * --flat-out, or directly by a harness via env:
 *  - push (DOUG_PUSH=1): confirm tier auto-approves, permission prompts lift;
 *    the block tier stays enforced.
 *  - flat-out (DOUG_FLAT_OUT=1): everything off, block tier included. For
 *    sandboxed runs only.
 * Read at call time so tests can toggle env between cases.
 */
export type RaceMode = "push" | "flat-out" | undefined;
export function raceMode(): RaceMode {
  const on = (v?: string) => !!v && v !== "0";
  if (on(process.env.DOUG_FLAT_OUT)) return "flat-out";
  if (on(process.env.DOUG_PUSH)) return "push";
  return undefined;
}

// Git subcommands that only read. Everything else is treated as mutative.
const GIT_SAFE = new Set([
  "status", "log", "diff", "show", "blame", "grep", "shortlog", "describe",
  "reflog", "fetch", "ls-files", "ls-tree", "ls-remote", "rev-parse",
  "rev-list", "cat-file", "merge-base", "name-rev", "cherry", "count-objects",
  "whatchanged", "diff-tree", "help", "version",
]);

// Read-only argument shapes for subcommands that both read and mutate.
const GIT_CONDITIONAL: Record<string, RegExp> = {
  branch: /^(\s+(-v|-vv|-a|-r|-l|--list|--show-current|(--merged|--no-merged|--contains)(\s+\S+)?))*\s*$/,
  stash: /^\s+(list|show)\b/,
  remote: /^(\s+(-v|show|get-url|\S+))?\s*$/,
  tag: /^(\s+(-l|--list|-n\d*|--contains|[^-\s]\S*))*\s*$/,
  config: /^\s+(--get|--get-all|--get-regexp|--list|-l)\b/,
  worktree: /^\s+list\b/,
  submodule: /^(\s+(status|summary))?\s*$/,
};

/** Returns a block reason if any git invocation in the command is mutative. */
function checkGit(command: string): string | undefined {
  // Examine each shell segment that invokes git
  for (const segment of command.split(/[;|]|&&|\|\|/)) {
    const match = segment.match(/(?:^|\s)git\s+((?:(?:-C\s+\S+|-c\s+\S+|--no-pager|--git-dir=\S+|--work-tree=\S+)\s+)*)([a-z][a-z-]*)(.*)$/);
    if (!match) continue;
    const sub = match[2];
    const rest = match[3] ?? "";
    if (GIT_SAFE.has(sub)) continue;
    if (GIT_CONDITIONAL[sub]?.test(rest)) continue;
    return `\`git ${sub}\` is mutative git — that's ${USER}'s job, never doug's. ${HAND_OFF}`;
  }
  return undefined;
}

const BLOCK_RULES: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /(?:^|[\s;|&])sudo\b/,
    reason: `sudo is a human task. ${HAND_OFF}`,
  },
  {
    pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+[^;|&]*(?:(?:^|\s)\/\s*$|\/\*|~\/?(?:\s|$)|\$HOME\b)/,
    reason: `Recursive delete aimed at / or the home directory. ${HAND_OFF}`,
  },
  {
    pattern: /(?:^|[\s;|&])(cat|bat|less|more|head|tail|cp|scp|open|code|vi|vim|nano|strings|xxd|base64|hexdump|grep|rg|awk|sed|sd)\b[^;|&]*(?:[\s/'"=]\.env(?:\.\w+)?\b|master\.key|credentials\.yml|\.claude\/settings\.json|auth\.json|\.netrc|id_rsa|id_ed25519|\.aws\/credentials|\.npmrc|\.pgpass|\.kube\/config|\.docker\/config\.json)/,
    reason: `That file conventionally holds secrets — anything read enters context and transcripts. Inspect structure only (e.g. \`jq 'keys'\`) or ask ${USER} for the specific non-secret field.`,
  },
];

const CONFIRM_RULES: { pattern: RegExp; label: string }[] = [
  { pattern: /\bbrew\s+(install|uninstall|remove|reinstall|upgrade|tap|untap|link|unlink|services)\b/, label: "Homebrew change" },
  { pattern: /\b(npm|pnpm)\s+(install|i|add|un|uninstall|remove|rm|update|upgrade|link)\b[^;|&]*(?:\s-g\b|--global\b)/, label: "global npm/pnpm install" },
  { pattern: /\byarn\s+global\b/, label: "global yarn install" },
  { pattern: /\bgem\s+(install|uninstall|update)\b/, label: "gem install" },
  { pattern: /\bpip3?\s+(install|uninstall)\b/, label: "pip install" },
  { pattern: /\bpipx\s+\S/, label: "pipx change" },
  { pattern: /\bcargo\s+install\b/, label: "cargo install" },
  { pattern: /\bgo\s+install\b/, label: "go install" },
  { pattern: /\b(mise)\s+(install|use|uninstall|upgrade|self-update)\b/, label: "mise change" },
  { pattern: /\b(curl|wget)\b[^;&]*\|\s*(ba|z|da)?sh\b/, label: "pipe-to-shell install" },
  { pattern: /\b(ln|cp|mv)\b[^;|&]*(\.local\/bin|\/usr\/local\/bin|\/opt\/homebrew)/, label: "write into a PATH/system location" },
  { pattern: /\bdefaults\s+write\b/, label: "macOS defaults write" },
  { pattern: /\blaunchctl\s+(load|unload|bootstrap|bootout|enable|disable)\b/, label: "launchctl change" },
];

/** True when guardrails already governs this command (block or confirm tier). */
export function coveredByGuardrails(command: string): boolean {
  return checkGit(command) !== undefined
    || BLOCK_RULES.some((r) => r.pattern.test(command))
    || CONFIRM_RULES.some((r) => r.pattern.test(command));
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const command = event.input.command ?? "";

    const mode = raceMode();
    if (mode === "flat-out") return;

    const gitReason = checkGit(command);
    if (gitReason) return { block: true, reason: gitReason };

    for (const rule of BLOCK_RULES) {
      if (rule.pattern.test(command)) return { block: true, reason: rule.reason };
    }

    for (const rule of CONFIRM_RULES) {
      if (!rule.pattern.test(command)) continue;
      if (mode === "push") return; // confirm tier auto-approves under --push
      if (!ctx.hasUI) {
        return { block: true, reason: `Machine-level change (${rule.label}) needs ${USER}'s approval and no UI is available to ask. ${HAND_OFF}` };
      }
      const ok = await ctx.ui.confirm("doug guardrails", `${rule.label}:\n\n${command}\n\nAllow?`);
      if (!ok) {
        return { block: true, reason: `${USER} declined the ${rule.label}. ${HAND_OFF}` };
      }
      return; // approved — let it through
    }
  });
}
