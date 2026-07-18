/**
 * doug permission prompts — a learning allowlist for mutative bash commands.
 *
 * Bash: read-only commands run free. Commands guardrails already governs
 * (block or confirm tier) are guardrails' business. Everything else prompts:
 * Allow once / Always allow / Deny. "Always allow" persists only the exact
 * command (allowExact in ~/.doug/permissions.json) — a payload command
 * like `rails runner "..."` never silently widens to its prefix. Prefix
 * grants (allowPrefixes) are honored but never written by the dialog; adding
 * one is a deliberate hand-edit of the file. The list is global to all doug
 * sessions. With no UI, non-allowlisted mutative commands are blocked.
 *
 * Edits: doug boots in manual mode — every edit/write prompts
 * Allow / Allow all edits / Deny. "Allow all edits" switches the session to
 * auto mode; /manual and /auto hop between modes, and the footer status
 * always shows the current mode. Manual mode with no UI blocks edits.
 * The boot default comes from ~/.doug/config.json ({"editMode": "auto"});
 * mode changes during a session are never written back — the config is the
 * deliberate default, the session is the exception.
 *
 * Plan mode: /plan enters a discuss-and-ground phase — edits are blocked
 * except plan files in the home dir's ~/.doug/plans/<project>/, mutative bash
 * is blocked without prompting, read-only exploration stays free, and planning
 * instructions are injected per-turn (no permanent token cost). The plan is
 * distilled into ~/.doug/plans/<project>/<date>-<slug>.md; /execute-plan [name] then
 * starts a fresh session seeded with only that file, so execution re-reads
 * nothing.
 *
 * Race modes (--push / --flat-out, see raceMode in guardrails.ts) lift all
 * gating in this extension — for headless runs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { coveredByGuardrails, raceMode } from "./guardrails.ts";

const DOUG_HOME = process.env.DOUG_HOME ?? join(homedir(), ".doug");
const PERM_PATH = join(DOUG_HOME, "permissions.json");

let USER = "the user";
// Flat ~/.doug/profile.json is canonical; agent/profile.json is the pre-flat-layout location.
for (const p of [join(DOUG_HOME, "profile.json"), join(DOUG_HOME, "agent", "profile.json")]) {
  try {
    USER = JSON.parse(readFileSync(p, "utf8")).name?.trim() || USER;
    break;
  } catch {}
}

// Binaries that only read or navigate. Anything else prompts until allowlisted.
const SAFE_BINARIES = new Set([
  "ls", "pwd", "cd", "echo", "printf", "cat", "bat", "head", "tail", "wc",
  "sort", "uniq", "cut", "tr", "column", "stat", "file", "du", "df", "tree",
  "find", "fd", "rg", "grep", "jq", "awk", "which", "whereis", "type", "env",
  "printenv", "date", "uname", "id", "whoami", "hostname", "diff", "cmp",
  "comm", "basename", "dirname", "realpath", "readlink", "shasum", "md5",
  "true", "false", "test", "ps", "lsof", "uptime",
  "git", // guardrails blocks mutative git; what passes it is read-only
]);

function normalize(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/** Conservative read-only check: every pipeline stage is a safe binary, no
 * file redirects, no command substitution. */
function isReadOnly(command: string): boolean {
  // Redirects to anything but /dev/null or an fd dup mean a file write.
  for (const m of command.matchAll(/(?:\d+|&)?>{1,2}\s*(\S+)/g)) {
    const target = m[1];
    if (target !== "/dev/null" && !target.startsWith("&")) return false;
  }
  // Command substitution can hide anything.
  if (command.includes("$(") || command.includes("`")) return false;
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    if (i >= tokens.length) continue;
    const bin = tokens[i].replace(/^[($]+/, "").split("/").pop() ?? "";
    if (!SAFE_BINARIES.has(bin)) return false;
  }
  return true;
}

/** Leading VAR=val assignments don't change what runs; drop them for matching. */
function stripEnvAssignments(command: string): string {
  const tokens = command.split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return tokens.slice(i).join(" ");
}

type Allowlist = { exact: string[]; prefixes: string[] };

function loadAllow(): Allowlist {
  try {
    const data = JSON.parse(readFileSync(PERM_PATH, "utf8"));
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((p: unknown) => typeof p === "string") : []);
    return { exact: strings(data.allowExact), prefixes: strings(data.allowPrefixes) };
  } catch {
    return { exact: [], prefixes: [] };
  }
}

function saveExact(command: string) {
  const { exact, prefixes } = loadAllow();
  if (!exact.includes(command)) exact.push(command);
  mkdirSync(dirname(PERM_PATH), { recursive: true });
  writeFileSync(PERM_PATH, JSON.stringify({ allowExact: exact, allowPrefixes: prefixes }, null, 2) + "\n");
}

type EditMode = "manual" | "auto" | "plan";

const MODE_STATUS: Record<EditMode, string> = {
  manual: "✋ manual edits",
  auto: "✏️ auto edits",
  plan: "📋 plan mode",
};

const planInstructions = (user: string, plansDir: string) => `
You are in plan mode: ${user} and you are designing a change together before any code gets written.
- Discuss first. Surface ambiguity, ask about intent, propose alternatives; don't rush to a plan file.
- Ground everything in this repository: read the relevant code (read-only commands are unrestricted) and cite exact file paths and line numbers. Never propose changes to code you haven't looked at.
- Edits and mutative commands are blocked in plan mode — that's the mode working, not an obstacle.
- When ${user} agrees the plan is ready, write it to ${plansDir}/<yyyy-mm-dd>-<short-slug>.md (you pick the slug; announce the filename clearly) with sections:
  ## Goal — what we're building and why, in a few sentences
  ## Grounding — exact file:line references, existing patterns to copy, constraints and decisions from this conversation, written so the implementer needs no further digging
  ## Steps — ordered, each naming its target files
  ## Verification — how to prove it works, kept token-cheap
  ## Out of scope — what we explicitly decided not to do
- The plan will be executed in a fresh session that sees ONLY the plan file. Everything the implementer needs must be in it.
- After writing the file, tell ${user} to run /execute-plan when ready.`;

/** Resolve which plan file to execute: named match, or newest by mtime. */
export function pickPlan(plansDir: string, name: string): string | undefined {
  let files: string[];
  try {
    files = readdirSync(plansDir).filter((f) => f.endsWith(".md"));
  } catch {
    return undefined;
  }
  if (name) files = files.filter((f) => f.includes(name));
  const paths = files.map((f) => join(plansDir, f));
  return paths.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const CONFIG_PATH = join(DOUG_HOME, "config.json");

/** doug's own config file (pi's settings.json is pi's). Unknown values fall
 * back to the conservative default. */
function bootEditMode(): EditMode {
  try {
    const mode = JSON.parse(readFileSync(CONFIG_PATH, "utf8")).editMode;
    if (mode === "manual" || mode === "auto") return mode;
  } catch {}
  return "manual";
}

export default function (pi: ExtensionAPI) {
  let editMode: EditMode = bootEditMode();

  const showMode = (ctx: any) => {
    const race = raceMode();
    ctx.ui.setStatus("doug-mode", race ? `🏎️ ${race === "flat-out" ? "flat out" : "push"}` : MODE_STATUS[editMode]);
  };
  // Plans live in the home dir (namespaced by project dir name), not in the
  // repo — so no project has to gitignore scratch plan files. Collisions
  // between same-named dirs are accepted as close-enough.
  const plansDirFor = (ctx: any) => join(DOUG_HOME, "plans", basename(resolve(ctx.cwd ?? process.cwd())));
  const setMode = (mode: EditMode, ctx: any) => {
    editMode = mode;
    showMode(ctx);
  };

  pi.on("session_start", async (_event, ctx) => showMode(ctx));

  pi.registerCommand("manual", {
    description: "Require live approval for every edit (doug's default)",
    handler: async (_args: string, ctx: any) => {
      setMode("manual", ctx);
      ctx.ui.notify("Edit mode: manual — every edit asks", "info");
    },
  });
  pi.registerCommand("auto", {
    description: "Allow all edits for this session",
    handler: async (_args: string, ctx: any) => {
      setMode("auto", ctx);
      ctx.ui.notify("Edit mode: auto — /manual to go back", "info");
    },
  });
  pi.registerCommand("plan", {
    description: "Plan mode: discuss and ground a change, then write a plan file",
    handler: async (_args: string, ctx: any) => {
      mkdirSync(plansDirFor(ctx), { recursive: true });
      setMode("plan", ctx);
      ctx.ui.notify("Plan mode — discuss, ground, distill. /execute-plan when the plan is written", "info");
    },
  });
  pi.registerCommand("execute-plan", {
    description: "Execute a plan from ~/.doug/plans in a fresh session (newest for this project, or /execute-plan <name>)",
    handler: async (args: string, ctx: any) => {
      const plan = pickPlan(plansDirFor(ctx), args.trim());
      if (!plan) {
        ctx.ui.notify(args.trim() ? `No plan matching "${args.trim()}" in ~/.doug/plans` : "No plans for this project in ~/.doug/plans", "error");
        return;
      }
      const content = readFileSync(plan, "utf8");
      setMode(bootEditMode(), ctx);
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        withSession: async (fresh: any) => {
          await fresh.sendUserMessage(
            `Execute the plan below, from ${plan}. Follow its Steps in order; the Grounding section already contains the file references and patterns you need — trust it instead of re-exploring.\n\n${content}`,
          );
        },
      });
    },
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (editMode !== "plan") return;
    return { systemPrompt: event.systemPrompt + "\n" + planInstructions(USER, plansDirFor(ctx)) };
  });

  pi.on("tool_call", async (event, ctx) => {
    // Race modes lift all permission gating; guardrails still enforces its
    // block tier under --push in its own handler.
    if (raceMode()) return;
    if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
      if (editMode === "auto") return;
      const path = event.input.path ?? "";
      if (editMode === "plan") {
        const target = resolve(ctx.cwd ?? process.cwd(), path);
        if (target.startsWith(plansDirFor(ctx) + "/")) return;
        return {
          block: true,
          reason: `Plan mode: no edits yet. Discuss the change with ${USER} and distill it into a plan file under ~/.doug/plans/ — that's the only writable location until /execute-plan.`,
        };
      }
      if (!ctx.hasUI) {
        return {
          block: true,
          reason: `doug is in manual edit mode and there is no UI to ask ${USER}. Describe the change you want to make instead of applying it.`,
        };
      }
      const ALLOW_ALL = "Allow all edits (this session)";
      const choice = await ctx.ui.select(`Edit ${path}?`, ["Allow", ALLOW_ALL, "Deny"]);
      if (choice === ALLOW_ALL) {
        setMode("auto", ctx);
        return;
      }
      if (choice === "Allow") return;
      return {
        block: true,
        reason: `${USER} declined this edit to ${path}. Ask what they'd like changed instead of retrying it.`,
      };
    }

    if (!isToolCallEventType("bash", event)) return;
    const command = normalize(event.input.command ?? "");
    if (!command) return;
    if (coveredByGuardrails(command)) return;
    if (isReadOnly(command)) return;
    if (editMode === "plan") {
      return {
        block: true,
        reason: `Plan mode: \`${command}\` is mutative and plan mode is read-only. Ground the plan with read-only commands; the change itself happens after /execute-plan.`,
      };
    }
    const stripped = stripEnvAssignments(command);
    const { exact, prefixes } = loadAllow();
    if (exact.includes(stripped)) return;
    if (prefixes.some((p) => stripped === p || stripped.startsWith(p + " "))) return;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `\`${command}\` is not on ${USER}'s allowlist and there is no UI to ask. Present the command for ${USER} to run, or ${USER} can add it to ~/.doug/permissions.json (allowExact / allowPrefixes).`,
      };
    }

    const ALWAYS = "Always allow this exact command";
    const choice = await ctx.ui.select(`Run this command?\n\n${command}`, ["Allow once", ALWAYS, "Deny"]);
    if (choice === ALWAYS) {
      saveExact(stripped);
      return;
    }
    if (choice === "Allow once") return;
    return {
      block: true,
      reason: `${USER} declined \`${command}\`. Don't retry it; ask ${USER} how to proceed.`,
    };
  });
}
