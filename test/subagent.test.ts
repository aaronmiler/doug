/**
 * Behavioral tests for the vendored subagent extension: agent discovery finds
 * scout.md with the expected shape (read-only, no bash), and the doug-added
 * model override resolves in precedence order: env > ~/.doug/config.json >
 * frontmatter. Run with: npm test
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "../agent/extensions/subagent/agents.ts";

// DOUG_HOME must be set before model.ts (which reads it at import time) loads.
process.env.DOUG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "doug-subagent-test-"));
const CONFIG_PATH = path.join(process.env.DOUG_HOME, "config.json");
const { resolveAgentModel } = await import("../agent/extensions/subagent/model.ts");

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

// discoverAgents reads getAgentDir()/agents, which honors <APP_NAME>_CODING_AGENT_DIR.
// This test imports pi-coding-agent directly (unshimmed by bin/doug), where
// APP_NAME defaults to "pi" — not DOUG_CODING_AGENT_DIR, which only applies once
// bin/doug's shim renames the package to "doug" (see README's "How it works").
// Point it at a throwaway copy of the real agent/agents dir either way.
const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "doug-subagent-test-"));
fs.mkdirSync(path.join(tmpAgentDir, "agents"), { recursive: true });
const scoutSrc = path.join(import.meta.dirname, "..", "agent", "agents", "scout.md");
fs.copyFileSync(scoutSrc, path.join(tmpAgentDir, "agents", "scout.md"));
process.env.PI_CODING_AGENT_DIR = tmpAgentDir;

const { agents } = discoverAgents(process.cwd(), "user");
const scout = agents.find((a) => a.name === "scout");

expect("scout discovered", Boolean(scout), true);
expect("scout description set", Boolean(scout?.description), true);
expect("scout tools", scout?.tools, ["read", "grep", "find", "ls"]);
expect("scout has no bash", scout?.tools?.includes("bash"), false);
expect("scout has no pinned model", scout?.model, undefined);

fs.rmSync(tmpAgentDir, { recursive: true, force: true });
delete process.env.PI_CODING_AGENT_DIR;

// resolveAgentModel precedence: env > ~/.doug/config.json agentModels > frontmatter
delete process.env.DOUG_SCOUT_MODEL;
if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);

expect("nothing set → undefined", resolveAgentModel({ name: "scout", model: undefined }), undefined);
expect("no env, no config, frontmatter set → frontmatter wins", resolveAgentModel({ name: "planner", model: "claude-sonnet-4-5" }), "claude-sonnet-4-5");

fs.writeFileSync(CONFIG_PATH, JSON.stringify({ agentModels: { scout: "claude-haiku-4-5" } }));
expect("config set, no env, no frontmatter → config wins", resolveAgentModel({ name: "scout", model: undefined }), "claude-haiku-4-5");
expect("config set, frontmatter also set → config wins over frontmatter", resolveAgentModel({ name: "scout", model: "claude-sonnet-4-5" }), "claude-haiku-4-5");
expect("config is per-agent, doesn't leak to other agents", resolveAgentModel({ name: "planner", model: undefined }), undefined);

process.env.DOUG_SCOUT_MODEL = "claude-opus-4-6";
expect("env set, config also set → env wins", resolveAgentModel({ name: "scout", model: "claude-sonnet-4-5" }), "claude-opus-4-6");
delete process.env.DOUG_SCOUT_MODEL;

fs.writeFileSync(CONFIG_PATH, "not json");
expect("malformed config.json falls back to frontmatter, no throw", resolveAgentModel({ name: "scout", model: "claude-sonnet-4-5" }), "claude-sonnet-4-5");

fs.unlinkSync(CONFIG_PATH);
fs.rmSync(process.env.DOUG_HOME, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
