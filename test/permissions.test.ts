/**
 * Behavioral tests for the permission-prompt extension: read-only commands run
 * free, guardrails-covered commands are skipped, mutative commands prompt and
 * "always allow" persists a prefix. Run with: npm test
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// DOUG_HOME must be set before the module (which reads it at import time) loads.
process.env.DOUG_HOME = mkdtempSync(join(tmpdir(), "doug-perm-test-"));
const PERM_PATH = join(process.env.DOUG_HOME, "permissions.json");
const { default: permissions, pickPlan } = await import("../agent/extensions/permissions.ts");

function instantiate() {
  const handlers: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const tools: Record<string, any> = {};
  permissions({
    on: (name: string, fn: any) => { handlers[name] = fn; },
    registerCommand: (name: string, def: any) => { commands[name] = def.handler; },
    registerTool: (def: any) => { tools[def.name] = def; },
  } as any);
  return { handlers, commands, tools };
}

const handler = instantiate().handlers.tool_call;

function run(command: string, opts: { hasUI?: boolean; choose?: string } = {}) {
  const selects: string[] = [];
  const ctx = {
    hasUI: opts.hasUI ?? true,
    ui: {
      select: async (_title: string, options: string[]) => {
        selects.push(_title);
        return opts.choose === "always" ? options.find((o) => o.startsWith("Always")) : opts.choose;
      },
    },
  };
  const event = { type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command } };
  return handler(event, ctx).then((result: any) => ({ result, prompted: selects.length > 0 }));
}

let failures = 0;
function check(name: string, ok: boolean) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}

// Read-only commands pass silently
for (const cmd of ["ls -la", "rg TODO src/", "cat a.txt | jq .x", "fd -e ts", "git log --oneline", "echo hi 2>&1", "echo hi > /dev/null", "FOO=1 grep x y.txt", "diff a b && echo same"]) {
  const { result, prompted } = await run(cmd);
  check(`read-only passes silently: ${cmd}`, result === undefined && !prompted);
}

// Regex metacharacters inside quotes are not shell metacharacters — must stay free
for (const cmd of ["rg 'a|b' src/", "rg 'foo -> bar'", "grep -E 'x|y' f.txt", "rg 'name;drop'", "rg '$(' .", 'rg "a > b" src/', "rg 'x && y'", 'rg "arrival|check_in|checkin" app/models/ota/reservation.rb', 'fd . app/models -t f -x basename | sort | rg -i "pms|post|sync"']) {
  const { result, prompted } = await run(cmd);
  check(`quoted regex metachars stay read-only: ${cmd}`, result === undefined && !prompted);
}

// Command substitution inside double quotes still executes — must not be read-only
for (const cmd of ['rg "$(cat evil)" src/', "cat `whoami`.txt"]) {
  const { result, prompted } = await run(cmd, { choose: "Deny" });
  check(`double-quoted substitution still prompts: ${cmd}`, result?.block === true && prompted);
}

// Guardrails-covered commands are not double-prompted here
for (const cmd of ["git commit -m x", "brew install wget", "sudo ls"]) {
  const { result, prompted } = await run(cmd);
  check(`guardrails-covered skipped: ${cmd}`, result === undefined && !prompted);
}

// Mutative commands prompt
{
  const { result, prompted } = await run("npm run build", { choose: "Allow once" });
  check("mutative prompts, allow-once allows", result === undefined && prompted);
}
{
  const { result, prompted } = await run("echo hi > out.txt", { choose: "Deny" });
  check("file redirect prompts, deny blocks", result?.block === true && prompted);
}
{
  const { result, prompted } = await run("echo $(date)", { choose: "Allow once" });
  check("command substitution is not read-only", result === undefined && prompted);
}
{
  const { result, prompted } = await run("cat a.txt | xargs rm", { choose: "Deny" });
  check("unsafe pipeline stage prompts", result?.block === true && prompted);
}

// Always-allow persists only the exact command
{
  const first = await run("npm test -- -t widget", { choose: "always" });
  const stored = JSON.parse(readFileSync(PERM_PATH, "utf8"));
  const repeat = await run("npm test -- -t widget", {});
  const variant = await run("npm test --watch", { choose: "Deny" });
  check("always-allow persists exact command only", first.prompted && stored.allowExact.includes("npm test -- -t widget") && !(stored.allowPrefixes ?? []).length);
  check("same exact command passes silently", repeat.result === undefined && !repeat.prompted);
  check("variant of allowed command still prompts", variant.prompted && variant.result?.block === true);
}

// Env assignments don't dodge the exact match
{
  const { result, prompted } = await run("CI=1 npm test -- -t widget", {});
  check("env-prefixed exact command still matches", result === undefined && !prompted);
}

// Hand-edited allowPrefixes are honored as prefixes
{
  const stored = JSON.parse(readFileSync(PERM_PATH, "utf8"));
  writeFileSync(PERM_PATH, JSON.stringify({ ...stored, allowPrefixes: ["cargo build"] }));
  const { result, prompted } = await run("cargo build --release", {});
  check("manual prefix grant passes silently", result === undefined && !prompted);
}

// No UI: mutative non-allowlisted blocks
{
  const { result, prompted } = await run("make deploy-docs", { hasUI: false });
  check("no UI blocks mutative command", result?.block === true && !prompted);
}

// --- Edit modes: fresh instance per scenario (mode is session state) ---
function editSession(opts: { hasUI?: boolean; choose?: string | ((options: string[]) => string); cwd?: string; input?: string } = {}) {
  const { handlers, commands, tools } = instantiate();
  const selects: string[] = [];
  const statuses: string[] = [];
  const notices: string[] = [];
  const sentMessages: string[] = [];
  const newSessions: any[] = [];
  const ctx = {
    hasUI: opts.hasUI ?? true,
    cwd: opts.cwd,
    sessionManager: { getSessionFile: () => "parent-session.jsonl" },
    newSession: async (options: any) => {
      newSessions.push(options);
      await options.withSession({ sendUserMessage: async (m: string) => { sentMessages.push(m); } });
      return { cancelled: false };
    },
    ui: {
      select: async (_title: string, options: string[]) => {
        selects.push(_title);
        return typeof opts.choose === "function" ? opts.choose(options) : opts.choose;
      },
      input: async (_title: string, _placeholder?: string) => opts.input,
      setStatus: (_key: string, text: string) => { statuses.push(text); },
      notify: (text: string) => { notices.push(text); },
    },
  };
  const call = (toolName: string, input: any) =>
    handlers.tool_call({ type: "tool_call", toolName, toolCallId: "t1", input }, ctx);
  return {
    edit: (path: string) => call("edit", { path, edits: [{ oldText: "a", newText: "b" }] }),
    write: (path: string) => call("write", { path, content: "" }),
    bash: (command: string) => call("bash", { command }),
    manual: () => commands.manual("", ctx),
    auto: () => commands.auto("", ctx),
    plan: () => commands.plan("", ctx),
    planDeep: () => commands.plan("deep", ctx),
    savePlan: (params: any) => tools.save_plan.execute("t1", params, undefined, undefined, ctx),
    plans: () => commands.plans("", ctx),
    executePlan: (args = "") => commands["execute-plan"](args, ctx),
    agentStart: () => handlers.before_agent_start({ prompt: "hi", systemPrompt: "BASE" }, ctx),
    sessionStart: () => handlers.session_start({}, ctx),
    selects,
    statuses,
    notices,
    sentMessages,
    newSessions,
  };
}

// Manual by default: every edit prompts, Allow is one-time
{
  const s = editSession({ choose: "Allow" });
  const r1 = await s.edit("a.ts");
  const r2 = await s.edit("a.ts");
  check("manual mode: each edit prompts", r1 === undefined && r2 === undefined && s.selects.length === 2);
}

// "Allow all edits" transitions to auto for the session
{
  const s = editSession({ choose: (options) => options.find((o) => o.startsWith("Allow all"))! });
  const r1 = await s.edit("a.ts");
  const r2 = await s.write("b.ts");
  check("allow-all transitions to auto", r1 === undefined && r2 === undefined && s.selects.length === 1);
  check("mode indicator updated on transition", s.statuses.some((t) => t.includes("auto")));
}

// Deny blocks the edit
{
  const s = editSession({ choose: "Deny" });
  const r = await s.edit("a.ts");
  check("manual mode: deny blocks edit", r?.block === true);
}

// Manual mode with no UI blocks
{
  const s = editSession({ hasUI: false });
  const r = await s.write("a.ts");
  check("manual mode: no UI blocks edit", r?.block === true && s.selects.length === 0);
}

// /auto and /manual hop modes
{
  const s = editSession({ choose: "Deny" });
  await s.auto();
  const r1 = await s.edit("a.ts");
  const promptsWhileAuto = s.selects.length;
  await s.manual();
  const r2 = await s.edit("a.ts");
  check("/auto allows edits silently", r1 === undefined && promptsWhileAuto === 0);
  check("/manual returns to prompting", r2?.block === true && s.selects.length === 1);
}

// Edit mode doesn't affect bash gating
{
  const s = editSession({});
  const r = await s.bash("ls -la");
  check("read-only bash unaffected by manual mode", r === undefined && s.selects.length === 0);
}

// --- Plan mode ---
const PROJECT = mkdtempSync(join(tmpdir(), "doug-plan-test-"));
const plansDirOf = (proj: string) => join(process.env.DOUG_HOME!, "plans", basename(proj));

// /plan: all edits + mutative bash blocked (funnel to save_plan), read-only free
{
  const s = editSession({ cwd: PROJECT });
  await s.plan();
  const editSrc = await s.edit("a.ts");
  const editPlan = await s.write(join(plansDirOf(PROJECT), "2026-07-17-test.md"));
  const bashMut = await s.bash("npm run build");
  const bashRead = await s.bash("rg TODO src/");
  check("plan mode: source edit blocked without prompt", editSrc?.block === true && s.selects.length === 0);
  check("plan mode: raw write also blocked (funnel to save_plan)", editPlan?.block === true);
  check("plan mode: mutative bash blocked without prompt", bashMut?.block === true && s.selects.length === 0);
  check("plan mode: read-only bash free", bashRead === undefined);
  check("plan mode: indicator shows plan", s.statuses.some((t) => t.includes("plan")));
}

// save_plan: approval writes a structured file + stamps written state
{
  const proj = mkdtempSync(join(tmpdir(), "doug-saveplan-"));
  const s = editSession({ cwd: proj, choose: "Save it" });
  await s.plan();
  const r = await s.savePlan({ goal: "Add a widget", grounding: "logic in Foo.tsx:12", steps: ["edit Foo.tsx"] });
  const files = readdirSync(plansDirOf(proj)).filter((f: string) => f.endsWith(".md"));
  check("save_plan writes a file on approval", r?.isError !== true && files.length === 1);
  const md = readFileSync(join(plansDirOf(proj), files[0]), "utf8");
  check("save_plan renders required sections", md.includes("## Goal") && md.includes("## Grounding") && md.includes("## Steps"));
  const state = JSON.parse(readFileSync(join(plansDirOf(proj), ".state.json"), "utf8"));
  check("save_plan stamps written, not dispatched", !!state[files[0]]?.written && state[files[0]]?.dispatched === null);
}

// save_plan: "not yet" and "push back" return feedback and write nothing
{
  const proj = mkdtempSync(join(tmpdir(), "doug-saveplan2-"));
  const s = editSession({ cwd: proj, choose: "Not yet — keep refining" });
  await s.plan();
  const r = await s.savePlan({ goal: "g", grounding: "x", steps: ["y"] });
  let wrote = false;
  try { wrote = readdirSync(plansDirOf(proj)).some((f: string) => f.endsWith(".md")); } catch {}
  check("save_plan 'not yet' returns feedback, no write", r?.isError === true && !wrote);

  const s2 = editSession({ cwd: proj, choose: "Push back with a note…", input: "add error handling" });
  await s2.plan();
  const r2 = await s2.savePlan({ goal: "g", grounding: "x", steps: ["y"] });
  check("save_plan 'push back' feeds the note back", r2?.isError === true && String(r2.content[0].text).includes("add error handling"));
}

// save_plan refused outside plan mode
{
  const proj = mkdtempSync(join(tmpdir(), "doug-saveplan3-"));
  const s = editSession({ cwd: proj });
  const r = await s.savePlan({ goal: "g", grounding: "x", steps: ["y"] });
  check("save_plan refused outside plan mode", r?.isError === true);
}

// Plan instructions inject only in plan mode; /plan deep escalates mid-plan
{
  const s = editSession({ cwd: PROJECT });
  const before = await s.agentStart();
  await s.plan();
  const during = await s.agentStart();
  await s.manual();
  const after = await s.agentStart();
  check("plan instructions only inject in plan mode",
    before === undefined && during?.systemPrompt?.includes("plan mode") && during.systemPrompt.startsWith("BASE") && after === undefined);
  await s.planDeep();
  const deep = await s.agentStart();
  check("/plan deep escalates to comprehensive instructions", deep?.systemPrompt?.includes("DEEP") === true);
}

// pickPlan: newest un-dispatched wins, name filters, empty dir is undefined
{
  const plansDir = plansDirOf(PROJECT);
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(join(plansDir, "2026-07-16-older.md"), "old plan");
  writeFileSync(join(plansDir, "2026-07-17-newer.md"), "new plan");
  utimesSync(join(plansDir, "2026-07-16-older.md"), new Date("2026-07-16"), new Date("2026-07-16"));
  check("pickPlan: newest by mtime", pickPlan(plansDir, "")?.endsWith("newer.md") === true);
  check("pickPlan: name filter", pickPlan(plansDir, "older")?.endsWith("older.md") === true);
  check("pickPlan: missing dir", pickPlan(join(PROJECT, "nope"), "") === undefined);
}

// pickPlan: dispatched plans are skipped for the default (no-name) pick
{
  const proj = mkdtempSync(join(tmpdir(), "doug-dispatch-"));
  const plansDir = plansDirOf(proj);
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(join(plansDir, "2026-07-16-a.md"), "a");
  writeFileSync(join(plansDir, "2026-07-17-b.md"), "b");
  utimesSync(join(plansDir, "2026-07-16-a.md"), new Date("2026-07-16"), new Date("2026-07-16"));
  writeFileSync(join(plansDir, ".state.json"), JSON.stringify({ "2026-07-17-b.md": { dispatched: "2026-07-17T00:00:00Z" } }));
  check("pickPlan: skips dispatched for default pick", pickPlan(plansDir, "")?.endsWith("a.md") === true);
  check("pickPlan: named pick still finds a dispatched plan", pickPlan(plansDir, "b")?.endsWith("b.md") === true);
}

// /execute-plan: confirm, fresh session seeded, mode reset, parent recorded, dispatched stamped
{
  const s = editSession({ cwd: PROJECT, choose: "Execute" });
  await s.executePlan();
  const seeded = s.sentMessages[0] ?? "";
  check("execute-plan seeds new session with plan content", s.newSessions.length === 1 && seeded.includes("new plan"));
  check("execute-plan seed forbids re-orientation", seeded.includes("Do NOT explore the repo"));
  check("execute-plan records parent session", s.newSessions[0].parentSession === "parent-session.jsonl");
  check("execute-plan resets mode to boot default", s.statuses[s.statuses.length - 1].includes("manual"));
  const state = JSON.parse(readFileSync(join(plansDirOf(PROJECT), ".state.json"), "utf8"));
  check("execute-plan stamps dispatched", !!state["2026-07-17-newer.md"]?.dispatched);
}

// /execute-plan: cancel at the confirm aborts; named lookup; no-plans notify
{
  const sCancel = editSession({ cwd: PROJECT, choose: "Cancel" });
  await sCancel.executePlan("older");
  check("execute-plan cancel aborts, no session", sCancel.newSessions.length === 0);

  const s = editSession({ cwd: PROJECT, choose: "Execute" });
  await s.executePlan("older");
  check("execute-plan honors name argument", (s.sentMessages[0] ?? "").includes("old plan"));

  const s2 = editSession({ cwd: mkdtempSync(join(tmpdir(), "doug-noplans-")) });
  await s2.executePlan();
  check("execute-plan with no plans notifies, no session", s2.newSessions.length === 0 && s2.notices.some((n) => n.includes("No un-dispatched plans")));
}

// /plans: deterministic listing with status, no session
{
  const proj = mkdtempSync(join(tmpdir(), "doug-plans-list-"));
  const plansDir = plansDirOf(proj);
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(join(plansDir, "2026-07-18-alpha.md"), "a");
  writeFileSync(join(plansDir, "2026-07-19-beta.md"), "b");
  writeFileSync(join(plansDir, ".state.json"), JSON.stringify({ "2026-07-18-alpha.md": { dispatched: "2026-07-18T00:00:00Z" } }));
  const s = editSession({ cwd: proj });
  await s.plans();
  const out = s.notices.join("\n");
  check("/plans lists both plans", out.includes("2026-07-18-alpha.md") && out.includes("2026-07-19-beta.md"));
  check("/plans shows dispatched and not-dispatched", out.includes("ago") && out.includes("not dispatched"));
  check("/plans opens no session", s.newSessions.length === 0);

  const empty = editSession({ cwd: mkdtempSync(join(tmpdir(), "doug-plans-empty-")) });
  await empty.plans();
  check("/plans on empty project notifies", empty.notices.some((n) => n.includes("No plans")));
}

// --- Race modes: --push / --flat-out (env-driven) lift all gating here ---
{
  process.env.DOUG_PUSH = "1";
  const s = editSession({ hasUI: false });
  const edit = await s.edit("a.ts");
  const bash = await s.bash("make deploy-docs");
  await s.sessionStart();
  check("push mode: edit free without UI despite manual mode", edit === undefined && s.selects.length === 0);
  check("push mode: non-allowlisted mutative bash free without UI", bash === undefined);
  check("push mode: footer shows race mode", s.statuses.some((t) => t.includes("push")));
  delete process.env.DOUG_PUSH;
}
{
  process.env.DOUG_FLAT_OUT = "1";
  const s = editSession({ hasUI: false });
  const edit = await s.edit("a.ts");
  const bash = await s.bash("echo hi > out.txt");
  await s.sessionStart();
  check("flat-out mode: edit free without UI", edit === undefined && s.selects.length === 0);
  check("flat-out mode: mutative bash free without UI", bash === undefined);
  check("flat-out mode: footer shows race mode", s.statuses.some((t) => t.includes("flat out")));
  delete process.env.DOUG_FLAT_OUT;
}

// config.json sets the boot mode (kept last: earlier scenarios rely on no config file)
{
  const CONFIG_PATH = join(process.env.DOUG_HOME!, "config.json");
  writeFileSync(CONFIG_PATH, JSON.stringify({ editMode: "auto" }));
  const s = editSession({ choose: "Deny" });
  const r = await s.edit("a.ts");
  check("doug.json editMode=auto boots in auto", r === undefined && s.selects.length === 0);

  writeFileSync(CONFIG_PATH, JSON.stringify({ editMode: "yolo" }));
  const s2 = editSession({ choose: "Deny" });
  const r2 = await s2.edit("a.ts");
  check("unknown editMode falls back to manual", r2?.block === true && s2.selects.length === 1);

  unlinkSync(CONFIG_PATH);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
