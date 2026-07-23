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
 * Plan mode: /plan enters a discuss-and-ground phase — all edits and mutative
 * bash are blocked, read-only exploration stays free, and planning instructions
 * are injected per-turn (no permanent token cost). /plan is light by default;
 * /plan deep asks for a comprehensive plan (switchable mid-plan). The plan is
 * never written by the model directly — it calls the save_plan tool, whose
 * typed schema (goal/grounding/steps/…) makes structure a precondition of
 * saving, and the user approves the save (Save / Not yet / Push back) before
 * anything lands. Saved plans live in ~/.doug/plans/<project>/ with a sibling
 * .state.json tracking written/dispatched. /execute-plan [name] picks the newest
 * un-dispatched plan (or a named one), confirms it (name + age + status), then
 * seeds a fresh session with only that file and an instruction to trust the
 * plan as its orientation rather than re-exploring the repo.
 *
 * Race modes (--push / --flat-out, see raceMode in guardrails.ts) lift all
 * gating in this extension — for headless runs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

/** Collapse quoted spans to a neutral placeholder so metacharacters *inside*
 * quotes (a regex pattern like `rg 'a|b'` or `rg 'foo>bar'`) aren't misread as
 * pipeline operators or redirects. Single-pass, quote-aware. Returns null when a
 * real command substitution ($( or a backtick outside single quotes) is present —
 * that can run anything, so the command is never read-only. */
function dequote(command: string): string | null {
  let out = "";
  for (let i = 0; i < command.length; ) {
    const c = command[i];
    if (c === "\\") {
      out += "X"; // escaped char is literal; placeholder keeps token boundaries
      i += 2;
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      out += "X";
      i = end === -1 ? command.length : end + 1;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === "\\") j++;
        else if (command[j] === "`" || (command[j] === "$" && command[j + 1] === "(")) return null;
      }
      out += "X";
      i = j < command.length ? j + 1 : command.length;
    } else if (c === "`" || (c === "$" && command[i + 1] === "(")) {
      return null;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Conservative read-only check: every pipeline stage is a safe binary, no
 * file redirects, no command substitution. */
function isReadOnly(command: string): boolean {
  const view = dequote(command);
  if (view === null) return false; // command substitution — can hide anything
  // Redirects to anything but /dev/null or an fd dup mean a file write.
  for (const m of view.matchAll(/(?:\d+|&)?>{1,2}\s*(\S+)/g)) {
    const target = m[1];
    if (target !== "/dev/null" && !target.startsWith("&")) return false;
  }
  for (const segment of view.split(/&&|\|\||[;|\n]/)) {
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
type PlanDepth = "light" | "deep";

const MODE_STATUS: Record<EditMode, string> = {
  manual: "✋ manual edits",
  auto: "✏️ auto edits",
  plan: "📋 plan mode",
};

// prompts/ lives in the repo; extensions are symlinked from it, so resolve the
// repo root from DOUG_REPO_DIR (exported by bin/doug at runtime) and fall back to
// this file's own location (correct under the test runner and as a backstop).
const REPO_ROOT = process.env.DOUG_REPO_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PLAN_TEMPLATE = join(REPO_ROOT, "prompts", "plan-mode.template.md");

const planInstructions = (user: string, depth: PlanDepth) => {
  const depthNote =
    depth === "deep"
      ? `\n- ${user} marked this a DEEP plan: be comprehensive. Exhaustive grounding (every relevant file:line, pattern, decision, constraint), every step enumerated, concrete verification. Err toward more detail — this is architecture-grade.`
      : "";
  return readFileSync(PLAN_TEMPLATE, "utf8").trimEnd().replaceAll("{{user}}", user).replace("{{depth_note}}", depthNote);
};

// Plain JSON Schema — this is exactly what typebox's Type.Object(...) emits
// (typebox 1.x schemas are standard JSON Schema, no symbols), so pi validates
// it identically without a bare `typebox` import that only resolves under pi's
// jiti aliases at runtime, not under the test runner.
const PLAN_PARAMS = {
  type: "object",
  required: ["goal", "grounding", "steps"],
  properties: {
    goal: { type: "string", description: "What we're building and why, in 1-3 sentences." },
    grounding: {
      type: "string",
      description:
        "The orientation the executor needs: exact file:line references, existing patterns to copy, and the constraints/decisions from this conversation. Write it so a fresh agent can open the files named in the steps and edit them WITHOUT exploring the repo to get its bearings.",
    },
    steps: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description: "Ordered implementation steps, each naming its target file(s).",
    },
    verification: { type: "string", description: "How to prove it works: specific commands/tests and the expected outcome. Keep it token-cheap." },
    out_of_scope: { type: "string", description: "What this plan deliberately does NOT do." },
    slug: { type: "string", description: "Short kebab-case filename slug; derived from the goal if omitted." },
  },
} as const;

interface PlanParams {
  goal: string;
  grounding: string;
  steps: string[];
  verification?: string;
  out_of_scope?: string;
  slug?: string;
}

const today = () => new Date().toISOString().slice(0, 10);

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "plan";
}

function renderPlan(p: PlanParams): string {
  const parts = [
    `## Goal\n\n${p.goal.trim()}`,
    `## Grounding\n\n${p.grounding.trim()}`,
    `## Steps\n\n${p.steps.map((s, i) => `${i + 1}. ${s.trim()}`).join("\n")}`,
  ];
  if (p.verification?.trim()) parts.push(`## Verification\n\n${p.verification.trim()}`);
  if (p.out_of_scope?.trim()) parts.push(`## Out of scope\n\n${p.out_of_scope.trim()}`);
  return parts.join("\n\n") + "\n";
}

/** Coarse human-readable age from an epoch-ms timestamp. */
function humanAge(ms: number): string {
  const s = Math.max(0, Date.now() - ms) / 1000;
  if (s < 90) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

// Sibling .state.json tracks each plan's lifecycle so /execute-plan can default
// to the newest UN-dispatched plan and never silently re-run a stale one.
type PlanState = Record<
  string,
  { written?: string; dispatched?: string | null; session?: string | null; baseCommit?: string; branch?: string; dirty?: boolean }
>;
const statePath = (dir: string) => join(dir, ".state.json");
function loadState(dir: string): PlanState {
  try {
    return JSON.parse(readFileSync(statePath(dir), "utf8"));
  } catch {
    return {};
  }
}
function writeState(dir: string, s: PlanState) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(dir), JSON.stringify(s, null, 2) + "\n");
}
function stampWritten(dir: string, file: string, git: { baseCommit?: string; branch?: string; dirty?: boolean } = {}) {
  const s = loadState(dir);
  s[file] = { ...s[file], written: new Date().toISOString(), dispatched: s[file]?.dispatched ?? null, ...git };
  writeState(dir, s);
}
function stampDispatched(dir: string, file: string, session: string | null) {
  const s = loadState(dir);
  s[file] = { ...s[file], dispatched: new Date().toISOString(), session };
  writeState(dir, s);
}

/** Git context captured when a plan is saved, so /execute-plan can measure how far
 * the repo has drifted from the plan's truth without the executor doing archaeology. */
function gitContext(cwd: string): { baseCommit?: string; branch?: string; dirty?: boolean } {
  const run = (a: string) => execSync(`git ${a}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    return { baseCommit: run("rev-parse HEAD"), branch: run("rev-parse --abbrev-ref HEAD"), dirty: run("status --porcelain").length > 0 };
  } catch {
    return {};
  }
}

/** A caveat prepended to the dispatch when the repo has moved since the plan was
 * written — naming only the plan-referenced files that changed, so the executor
 * knows how far its grounding can be trusted. Falls back to wall-clock age when
 * there's no git metadata to compare (older plans, or a non-git project). */
function driftNote(saved: PlanState[string] | undefined, cwd: string, planText: string, mtimeMs: number): string {
  const now = gitContext(cwd);
  if (!saved?.baseCommit || !now.baseCommit) {
    return Date.now() - mtimeMs > 24 * 3_600_000
      ? `\n\n⚠️ This plan is ${humanAge(mtimeMs)} old and predates drift tracking. Spot-check that its file:line references still match the current files before editing; if anything moved, stop and flag it.`
      : "";
  }
  if (now.baseCommit === saved.baseCommit) {
    return saved.dirty
      ? `\n\n⚠️ This plan was written against uncommitted changes on \`${saved.branch}\`; the working tree may differ from what its grounding assumes. Verify before editing.`
      : "";
  }
  const run = (a: string) => {
    try {
      return execSync(`git ${a}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  let ancestor = false;
  try {
    execSync(`git merge-base --is-ancestor ${saved.baseCommit} HEAD`, { cwd, stdio: "ignore" });
    ancestor = true;
  } catch {}
  const from = ancestor ? saved.baseCommit : run(`merge-base ${saved.baseCommit} HEAD`);
  const changed = from ? run(`diff --name-only ${from} HEAD`).split("\n").filter(Boolean) : [];
  const touched = changed.filter((f) => planText.includes(f) || planText.includes(basename(f)));
  const where = ancestor
    ? "The repo has advanced since this plan was written"
    : `This plan was written on \`${saved.branch}\`; you're now on \`${now.branch}\`, which has diverged`;
  if (!touched.length) {
    return `\n\n${where}, but none of the files it references changed — the grounding should still hold. Spot-check line numbers as you go.`;
  }
  return `\n\n⚠️ ${where}. Files it references that have since changed: ${touched.join(", ")}. Re-read those and confirm the grounding still matches before editing; if line refs moved, adjust or stop and flag.`;
}

/** Resolve which plan to execute: a named match spans all plans; otherwise the
 * newest UN-dispatched one (so a stale, already-run plan is never picked blind). */
export function pickPlan(plansDir: string, name: string): string | undefined {
  let files: string[];
  try {
    files = readdirSync(plansDir).filter((f) => f.endsWith(".md"));
  } catch {
    return undefined;
  }
  const state = loadState(plansDir);
  files = name ? files.filter((f) => f.includes(name)) : files.filter((f) => !state[f]?.dispatched);
  const paths = files.map((f) => join(plansDir, f));
  return paths.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const EXEC_PREAMBLE =
  "Execute the plan below. It is self-contained and is your orientation for this repository — read only the files named in the Steps that you are about to edit. Do NOT explore the repo to get your bearings or rebuild context; everything you need is in the plan. If a Step needs something the plan doesn't give you — how to resolve a path, which of several patterns to follow, a decision it never made — STOP and ask after at most one confirming read. Do not go hunting through the repo to fill the gap: exploring to reconstruct missing grounding is the exact failure this mode exists to prevent. Follow the Steps in order.";

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
  let planDepth: PlanDepth = "light";

  const showMode = (ctx: any) => {
    const race = raceMode();
    const status = race
      ? `🏎️ ${race === "flat-out" ? "flat out" : "push"}`
      : editMode === "plan"
        ? `📋 plan${planDepth === "deep" ? "·deep" : ""}`
        : MODE_STATUS[editMode];
    ctx.ui.setStatus("doug-mode", status);
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
    description: "Plan mode: discuss and ground a change before coding (/plan deep for a comprehensive plan)",
    handler: async (args: string, ctx: any) => {
      planDepth = /\bdeep\b/i.test(args) ? "deep" : "light";
      setMode("plan", ctx);
      ctx.ui.notify(
        planDepth === "deep"
          ? "Plan mode (deep) — comprehensive plan. Save with save_plan; /execute-plan when ready"
          : "Plan mode — discuss, ground, then save_plan when ready. /plan deep for more depth",
        "info",
      );
    },
  });
  pi.registerCommand("execute-plan", {
    description: "Execute a plan from ~/.doug/plans in a fresh session (newest un-dispatched for this project, or /execute-plan <name>)",
    handler: async (args: string, ctx: any) => {
      const dir = plansDirFor(ctx);
      const plan = pickPlan(dir, args.trim());
      if (!plan) {
        ctx.ui.notify(
          args.trim()
            ? `No plan matching "${args.trim()}" in ~/.doug/plans`
            : "No un-dispatched plans for this project — name one to re-run an executed plan",
          "error",
        );
        return;
      }
      const file = basename(plan);
      const st = loadState(dir)[file];
      const status = st?.dispatched ? `already dispatched ${humanAge(Date.parse(st.dispatched))} ago` : "not yet dispatched";
      if (ctx.hasUI) {
        const RUN = "Execute";
        const choice = await ctx.ui.select(`Execute this plan?\n\n${file}\nwritten ${humanAge(statSync(plan).mtimeMs)} ago · ${status}`, [RUN, "Cancel"]);
        if (choice !== RUN) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }
      }
      const content = readFileSync(plan, "utf8");
      const drift = driftNote(st, ctx.cwd ?? process.cwd(), content, statSync(plan).mtimeMs);
      stampDispatched(dir, file, ctx.sessionManager.getSessionFile());
      setMode(bootEditMode(), ctx);
      await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        withSession: async (fresh: any) => {
          await fresh.sendUserMessage(`${EXEC_PREAMBLE}${drift}\n\n(from ${plan})\n\n${content}`);
        },
      });
    },
  });

  pi.registerCommand("plans", {
    description: "List saved plans for this project and their status (no execution)",
    handler: async (_args: string, ctx: any) => {
      const dir = plansDirFor(ctx);
      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".md"));
      } catch {
        files = [];
      }
      if (!files.length) {
        ctx.ui.notify("No plans for this project yet — /plan to make one", "info");
        return;
      }
      const state = loadState(dir);
      const rows = files
        .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m)
        .map(({ f, m }) => {
          const st = state[f];
          const status = st?.dispatched ? `dispatched ${humanAge(Date.parse(st.dispatched))} ago` : "not dispatched";
          return `  ${f}  ·  ${humanAge(m)} old  ·  ${status}`;
        });
      ctx.ui.notify(`Plans in ${dir}:\n${rows.join("\n")}`, "info");
    },
  });

  // save_plan is the ONLY way to persist a plan (plan mode blocks raw writes).
  // The typed schema makes structure a precondition; the user approves the save.
  pi.registerTool({
    name: "save_plan",
    label: "Save plan",
    description: `Persist the agreed plan to a file. Plan mode only. Call this only once ${USER} has agreed the plan is ready — ${USER} confirms the save, and may push back with changes.`,
    parameters: PLAN_PARAMS as any,
    executionMode: "sequential",
    async execute(_toolCallId: string, params: PlanParams, _signal: unknown, _onUpdate: unknown, ctx: any) {
      if (editMode !== "plan") {
        return { isError: true, content: [{ type: "text", text: "save_plan is only available in plan mode (/plan)." }] };
      }
      if (ctx.hasUI) {
        const SAVE = "Save it";
        const NOT_YET = "Not yet — keep refining";
        const PUSH = "Push back with a note…";
        const preview = `${params.goal.trim()}\n\nSteps:\n${params.steps.map((s, i) => `  ${i + 1}. ${s.trim()}`).join("\n")}`;
        const choice = await ctx.ui.select(`Save this plan?\n\n${preview}`, [SAVE, NOT_YET, PUSH]);
        if (choice === PUSH) {
          const note = await ctx.ui.input("What needs to change?", "Your note to the planner");
          return {
            isError: true,
            content: [{ type: "text", text: note?.trim() ? `${USER} pushed back — do not save yet: ${note.trim()}` : `${USER} wants to keep refining the plan.` }],
          };
        }
        if (choice !== SAVE) {
          return { isError: true, content: [{ type: "text", text: `${USER} isn't ready to save — keep refining the plan with them.` }] };
        }
      }
      const dir = plansDirFor(ctx);
      mkdirSync(dir, { recursive: true });
      const file = `${today()}-${slugify(params.slug || params.goal)}.md`;
      const path = join(dir, file);
      writeFileSync(path, renderPlan(params));
      stampWritten(dir, file, gitContext(ctx.cwd ?? process.cwd()));
      ctx.ui?.notify?.(`Plan saved: ${path}`, "info");
      return { content: [{ type: "text", text: `Plan saved to ${path}. Tell ${USER} to run /execute-plan when ready.` }] };
    },
  });

  pi.on("before_agent_start", async (event: any) => {
    if (editMode !== "plan") return;
    return { systemPrompt: event.systemPrompt + "\n" + planInstructions(USER, planDepth) };
  });

  pi.on("tool_call", async (event, ctx) => {
    // Race modes lift all permission gating; guardrails still enforces its
    // block tier under --push in its own handler.
    if (raceMode()) return;
    if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
      if (editMode === "auto") return;
      const path = event.input.path ?? "";
      if (editMode === "plan") {
        return {
          block: true,
          reason: `Plan mode is read-only for code — no direct edits or writes. Discuss and ground the change with ${USER}, then call the save_plan tool to persist it (that's the only write path here).`,
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
