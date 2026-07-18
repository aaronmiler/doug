/**
 * Behavioral tests for the flip-flop detector: drives the tool_call/input
 * handlers with fake edit/bash sequences and checks when doug is interrupted.
 * Run with: npm test
 */
import flipflop from "../agent/extensions/flipflop.ts";

function setup(hasUI: boolean, confirmResponse = true) {
  const handlers: Record<string, any> = {};
  flipflop({ on: (name: string, fn: any) => { handlers[name] = fn; } } as any);
  const confirms: string[] = [];
  const ctx = {
    hasUI,
    ui: { confirm: async (_title: string, message: string) => { confirms.push(message); return confirmResponse; } },
  };
  const call = (toolName: string, input: any) =>
    handlers.tool_call({ type: "tool_call", toolName, toolCallId: "t1", input }, ctx);
  return {
    edit: (path: string) => call("edit", { path, edits: [{ oldText: "a", newText: "b" }] }),
    write: (path: string) => call("write", { path, content: "" }),
    bash: (command: string) => call("bash", { command }),
    read: (path: string) => call("read", { path }),
    input: () => handlers.input({ type: "input", text: "user steering" }, ctx),
    confirms,
  };
}

let failures = 0;
function check(name: string, ok: boolean) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}

// Spray-and-pray with no UI: 3rd edit to the same file is blocked
{
  const s = setup(false);
  await s.edit("a.ts"); await s.bash("npm test");
  await s.edit("a.ts"); await s.read("a.ts"); await s.bash("npm test");
  const r = await s.edit("a.ts");
  check("no UI: 3rd edit in a same-command cycle blocks", r?.block === true);
}

// With UI, human says keep going: edit allowed, and it takes two fresh cycles to re-trigger
{
  const s = setup(true, true);
  await s.edit("a.ts"); await s.bash("npm test");
  await s.edit("a.ts"); await s.bash("npm test");
  const r3 = await s.edit("a.ts");
  check("UI keep-going: 3rd edit allowed after confirm", r3 === undefined && s.confirms.length === 1);
  await s.bash("npm test");
  const r4 = await s.edit("a.ts");
  await s.bash("npm test");
  const r5 = await s.edit("a.ts");
  check("keep-going resets: next two edits pass silently", r4 === undefined && r5 === undefined && s.confirms.length === 1);
  await s.bash("npm test");
  const r6 = await s.edit("a.ts");
  check("cycle re-detected after two fresh gaps", r6 === undefined && s.confirms.length === 2);
}

// With UI, human pauses: edit blocked
{
  const s = setup(true, false);
  await s.edit("a.ts"); await s.bash("npm test");
  await s.edit("a.ts"); await s.bash("npm test");
  const r = await s.edit("a.ts");
  check("UI pause: 3rd edit blocked", r?.block === true);
}

// Different command each gap: not spray-and-pray
{
  const s = setup(false);
  await s.edit("a.ts"); await s.bash("npm test");
  await s.edit("a.ts"); await s.bash("npm run lint");
  const r = await s.edit("a.ts");
  check("different commands between edits: allowed", r === undefined);
}

// Consecutive edits with no commands between: refining, not guessing
{
  const s = setup(false);
  await s.edit("a.ts"); await s.edit("a.ts"); await s.edit("a.ts");
  const r = await s.edit("a.ts");
  check("edits without runs between: allowed", r === undefined);
}

// Interleaved files: another file's edits don't break detection for a.ts
{
  const s = setup(false);
  await s.edit("a.ts"); await s.bash("npm test");
  await s.edit("b.ts"); await s.bash("npm test");
  await s.edit("a.ts"); await s.bash("npm test");
  const r = await s.edit("a.ts");
  check("interleaved files: a.ts cycle still detected", r?.block === true);
}

// A new user prompt resets tracking
{
  const s = setup(false);
  await s.edit("a.ts"); await s.bash("npm test");
  await s.edit("a.ts");
  await s.input();
  await s.bash("npm test");
  const r = await s.edit("a.ts");
  check("user input resets the cycle", r === undefined);
}

// write tool counts the same as edit
{
  const s = setup(false);
  await s.write("a.ts"); await s.bash("npm test");
  await s.write("a.ts"); await s.bash("npm test");
  const r = await s.write("a.ts");
  check("write tool cycles detected", r?.block === true);
}

// Whitespace-only differences in the command still match
{
  const s = setup(false);
  await s.edit("a.ts"); await s.bash("npm  test");
  await s.edit("a.ts"); await s.bash("npm test ");
  const r = await s.edit("a.ts");
  check("commands match after whitespace normalization", r?.block === true);
}

// Relative and absolute paths to the same file are one file
{
  const s = setup(false);
  const abs = `${process.cwd()}/a.ts`;
  await s.edit("a.ts"); await s.bash("npm test");
  await s.edit(abs); await s.bash("npm test");
  const r = await s.edit("a.ts");
  check("relative/absolute paths tracked as one file", r?.block === true);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
