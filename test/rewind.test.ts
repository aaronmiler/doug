/**
 * Behavioral tests for the rewind extension: exercises the pure branch-walking
 * helpers against synthetic session branches, then drives the command handler
 * with a fake ctx to check the confirm/navigate wiring.
 * Run with: npm test
 */
import rewind, { findUserTurn, editedPaths, promptPreview } from "../agent/extensions/rewind.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  [${e}→${a}]`);
}

// Session entries are root→leaf; ids are positional so assertions read cleanly.
let n = 0;
const user = (text: string) => ({ type: "message", id: `u${n++}`, message: { role: "user", content: text } });
const assistant = (...blocks: any[]) => ({ type: "message", id: `a${n++}`, message: { role: "assistant", content: blocks } });
const text = (t: string) => ({ type: "text", text: t });
const call = (name: string, args: any) => ({ type: "toolCall", id: `t${n++}`, name, arguments: args });
const result = (out: string) => ({ type: "message", id: `r${n++}`, message: { role: "toolResult", content: [text(out)] } });

// --- findUserTurn: depth counts user messages, not entries ---
const branch = [
  user("build the thing"),
  assistant(text("done"), call("edit", { path: "a.ts" })),
  result("ok"),
  user("what if we used X?"),
  assistant(text("sure"), call("edit", { path: "b.ts" }), call("edit", { path: "c.ts" })),
  result("ok"),
];
check("depth 1 → last user turn", findUserTurn(branch, 1), 3);
check("depth 2 → prior user turn", findUserTurn(branch, 2), 0);
check("depth past root → -1", findUserTurn(branch, 3), -1);
check("empty branch → -1", findUserTurn([], 1), -1);
check("no user messages → -1", findUserTurn([assistant(text("hi"))], 1), -1);

// --- editedPaths: only edit/write tools, deduped, first-touched order ---
check("edits after last user turn", editedPaths(branch, 3), ["b.ts", "c.ts"]);
check("edits across whole branch", editedPaths(branch, 0), ["a.ts", "b.ts", "c.ts"]);
check(
  "reads and bash are not edits",
  editedPaths([assistant(call("read", { path: "x.ts" }), call("bash", { command: "ls" }))], 0),
  [],
);
check(
  "write counts, duplicates collapse",
  editedPaths([assistant(call("write", { path: "x.ts" })), assistant(call("edit", { path: "x.ts" }))], 0),
  ["x.ts"],
);
check("pure discussion → no files", editedPaths([user("hm"), assistant(text("thoughts"))], 0), []);
check("malformed content is skipped", editedPaths([{ type: "message", message: { role: "assistant" } }], 0), []);

// --- promptPreview: first line, truncated ---
check("preview takes first line", promptPreview(user("what if we used X?\nmore detail")), "what if we used X?");
check("preview truncates", promptPreview(user("y".repeat(80))), "y".repeat(59) + "…");
check("preview of block content", promptPreview({ message: { role: "user", content: [text("hello there")] } }), "hello there");

// --- command handler wiring ---
let handler: any;
rewind({ registerCommand: (_name: string, spec: any) => { handler = spec.handler; } } as any);

function fakeCtx(entries: any[], choice: string) {
  const calls: any = { selected: null, navigated: null, notes: [] };
  return {
    calls,
    ctx: {
      hasUI: true,
      sessionManager: { getBranch: () => entries },
      ui: {
        select: async (prompt: string) => { calls.selected = prompt; return choice; },
        notify: (msg: string) => calls.notes.push(msg),
      },
      navigateTree: async (id: string, opts: any) => { calls.navigated = { id, opts }; return {}; },
    },
  };
}

let f = fakeCtx(branch, "Rewind");
await handler("", f.ctx);
check("navigates to the last user entry", f.calls.navigated?.id, branch[3].id);
check("plain rewind does not summarize", f.calls.navigated?.opts?.summarize, false);
check("confirm names the doomed files", /b\.ts, c\.ts/.test(f.calls.selected), true);
check("confirm quotes the prompt", /what if we used X\?/.test(f.calls.selected), true);

f = fakeCtx(branch, "Rewind + leave a note");
await handler("", f.ctx);
check("note option summarizes", f.calls.navigated?.opts?.summarize, true);

f = fakeCtx(branch, "Cancel");
await handler("", f.ctx);
check("cancel does not navigate", f.calls.navigated, null);

f = fakeCtx(branch, "Rewind");
await handler("2", f.ctx);
check("/rewind 2 goes back two turns", f.calls.navigated?.id, branch[0].id);

f = fakeCtx([user("only turn"), assistant(text("hi"))], "Rewind");
await handler("", f.ctx);
check("no files → confirm omits the disk warning", /stay on disk/.test(f.calls.selected), false);

f = fakeCtx([assistant(text("hi"))], "Rewind");
await handler("", f.ctx);
check("nothing to rewind → no navigate", f.calls.navigated, null);
check("nothing to rewind → warns", f.calls.notes.length > 0, true);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
