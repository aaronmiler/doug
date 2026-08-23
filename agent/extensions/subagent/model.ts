/**
 * doug addition: per-agent model override, checked in this order:
 *   1. DOUG_<AGENT_NAME>_MODEL env var — a one-off override for a single run
 *   2. agentModels[name] in ~/.doug/config.json — the persisted default
 *   3. the agent's own frontmatter `model`
 *   4. unset — the child inherits doug's own model
 * A persisted default matters because agent frontmatter can't read env, and
 * hardcoding a model (e.g. Haiku) in frontmatter isn't safe on every provider
 * (Claude 5 is sales-gated on some Bedrock accounts) — config.json lets a user
 * pin a model for their own setup without editing the vendored agent file.
 *
 * Split out from index.ts so it can be unit-tested with plain `node
 * --experimental-strip-types` — index.ts pulls in @earendil-works/pi-tui and
 * pi-ai, which only resolve through pi's own jiti-aliased extension loader,
 * not node's native module resolution.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "./agents.ts";

const DOUG_HOME = process.env.DOUG_HOME ?? join(homedir(), ".doug");
const CONFIG_PATH = join(DOUG_HOME, "config.json");

function configuredAgentModel(name: string): string | undefined {
  try {
    const agentModels = JSON.parse(readFileSync(CONFIG_PATH, "utf8")).agentModels;
    const model = agentModels?.[name];
    return typeof model === "string" && model ? model : undefined;
  } catch {
    return undefined;
  }
}

export function resolveAgentModel(agent: Pick<AgentConfig, "name" | "model">): string | undefined {
  const envOverride = process.env[`DOUG_${agent.name.toUpperCase()}_MODEL`];
  return envOverride || configuredAgentModel(agent.name) || agent.model;
}
