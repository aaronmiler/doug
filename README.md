```
      ██
    ██████                                                  doug
  ██████████
    ██████
 ████████████
   ████████
██████████████
      ██
      ██

```

An opinionated personal coding assistant. doug is a branded distribution of
[pi](https://github.com/earendil-works/pi-mono), built on pi's official
rebranding mechanism — no fork, no global installs: pi is vendored and
pinned in-repo, modified only by one small cosmetic patch
(see [Branding patches](MAINTAINING.md#branding-patches)).
He learns who you are on first run, keeps his identity in a version-controlled
template, and enforces a clear line between his tasks and yours.

## How it works

- pi is **vendored**: pinned in this repo's `package.json` + lockfile and
  installed into the repo's `node_modules`. doug depends on nothing global.
- `bin/doug` regenerates a shim package dir at `~/.doug/shim` on every launch:
  the vendored pi's `package.json` patched with
  `piConfig: { name: "doug", configDir: ".agents" }`, plus symlinks to pi's
  `dist`, `docs`, `examples`, `README.md`, and `CHANGELOG.md`.
- It points `PI_PACKAGE_DIR` at the shim and runs the vendored pi. pi reads
  its branding from there — the banner and `DOUG_*` env vars become doug's.
  Machine-level config stays doug-specific at `~/.doug` (pinned via
  `DOUG_CODING_AGENT_DIR`, since `configDir` alone would send it to `~/.agents`),
  while per-project resources use the standard `.agents/` dir (from `configDir`) —
  so doug drops into any repo without leaving a branded config folder behind.
- `prompts/system.template.md` is doug's identity/system prompt. On every launch
  the launcher renders it — against `~/.doug/profile.json` and ground truth
  resolved fresh from the machine (see [Prompt placeholders](#prompt-placeholders))
  — into `~/.doug/agent/SYSTEM.md`, where pi
  picks it up as a full system-prompt replacement. Missing profile on an
  interactive first run triggers a short onboarding prompt; non-interactive
  runs fall back to "the user". Edit template or profile; both take effect on
  the next launch.

### Prompt placeholders

`bin/doug` substitutes these when rendering `system.template.md`. The identity
pair comes from the profile; the rest is an Environment block of ground truth,
re-resolved every launch so the prompt states facts instead of assumptions.

| Placeholder | Source | Why it exists |
| --- | --- | --- |
| `{{name}}` | `profile.json` | Who doug is working with. |
| `{{about}}` | `profile.json` | Their role and standing notes, or empty. |
| `{{date}}` | local date, `en-CA` (ISO, not UTC) | Stops doug disbelieving repo timestamps that postdate its training data — Rails migration filenames are the usual trigger. Date only: `SYSTEM.md` is rewritten every launch, and a clock would churn the prompt all day. |
| `{{os}}` | `uname -s -r` | BSD vs GNU flag splits (`sed -i`, `date`, `stat`, `xargs`). |
| `{{shell}}` | pi's own resolution order | pi runs the bash tool through `/bin/bash -c`, **not** `$SHELL` — so doug must not assume the user's login-shell syntax, aliases, or functions. |
| `{{shell_note}}` | `BASH_VERSION` | Warns off bash 4+ syntax when `/bin/bash` is 3.x, as it is on macOS. Empty otherwise. |
| `{{tools}}` | `command -v rg fd sd jq` | The tool-preference list is a probe, not an assertion, so the template survives a machine without them. |
| `{{scratch_dir}}` | `~/.doug/tmp/<timestamp>-<pid>`, created fresh each launch | Gives doug somewhere localized to redirect command output / intermediate files instead of `/tmp`. Dirs older than 7 days are pruned on launch, so no manual cleanup is needed. |

The same facts are exported as `DOUG_PLATFORM`, `DOUG_OS`, `DOUG_SHELL`,
`DOUG_SHELL_VER`, `DOUG_TOOLS`, and `DOUG_SCRATCH_DIR`, so extensions can read
them from `process.env` rather than re-detecting.

## Install

Prerequisites: git, node >= 22.19 installed anywhere (PATH or any common
version manager — no particular tooling required), `~/.local/bin` on PATH.

One-liner (clones to `~/.local/share/doug`, or updates an existing install):

```bash
curl -fsSL https://raw.githubusercontent.com/aaronmiler/doug/main/bootstrap.sh | sh
```

Or from a checkout:

```bash
./install.sh   # vendors pi (npm ci + branding patches), symlinks doug onto PATH
doug           # first run: onboarding (profile.json), then /login for a provider
npm test       # optional: run the guardrails test suite
```

## Updating & versioning

doug versions by git sha — no release numbers, `main` is the release.

```bash
doug update      # git pull --ff-only + re-run install.sh (npm ci if the lockfile moved)
doug --version   # e.g. `doug 4024485 (2026-07-17) · pi 0.80.10`
```

`doug update` follows the launcher symlink back to whichever repo it points at
(a dev checkout included), so there's only ever one copy to keep fresh.
Re-running the curl one-liner does the same thing.

## Headless & race modes

pi's `-p` runs a prompt non-interactively, but doug's permission layers
hard-block mutative work when there's no UI to ask. Two flags lift them, in
increasing order of trust:

```bash
doug --push -p "..."      # no prompts: edits free, bash allowlist skipped,
                          # installs auto-approved. Guardrails (mutative git,
                          # sudo, secret reads, deploys) still enforced.
doug --flat-out -p "..."  # everything --push does, plus guardrails off.
                          # Sandboxed runs (evals, containers) only.
```

Both modes also skip the flip-flop detector — its check-in with a human has no
one to ask headless.

The flags just set `DOUG_PUSH=1` / `DOUG_FLAT_OUT=1`, so a harness can set the
env vars directly instead. Race modes override the edit modes below
(manual/auto/plan) for the whole run; the footer shows 🏎️ when one is active.
Neither is ever a config default — the flag is the decision, per invocation.

## Commands

doug adds these slash commands on top of pi's built-ins (`/hotkeys` lists them
all). Every one is handled in-process by doug's extensions — no model loop:

| Command | What it does |
|---|---|
| `/manual` | Require live approval for every edit — doug's boot default (footer ✋). |
| `/auto` | Allow all edits for the rest of the session (footer ✏️); `/manual` to go back. |
| `/plan` | Enter plan mode: discuss and ground a change while all code edits/writes are blocked. `/plan deep` asks for a comprehensive plan; either is switchable mid-plan (footer 📋 / 📋·deep). |
| `/execute-plan [name]` | Run a saved plan in a fresh session — newest un-dispatched by default, or a named match. Confirms (name + age + status) before starting. |
| `/plans` | List this project's saved plans and their written/dispatched status. Never executes anything. |
| `/rewind [n]` | Discard the last turn from context — moves the session back to before your last message, so a path doug shouldn't have taken is gone rather than argued out of. `/rewind 2` goes back two turns. Files are **not** reverted; the confirm names what stays on disk. |
| `/clear` | Start a fresh session — an alias for pi's built-in `/new`, for muscle memory from other tools. |

Plans are written by the model calling the `save_plan` tool — its typed schema
requires goal/grounding/steps, and doug asks you to approve (Save / Not yet /
Push back) before anything lands on disk. `save_plan` works in **any mode**, not
just plan mode: when an approach gets agreed mid-task, doug can persist it
without a `/plan` detour that throws away the context you just built. What plan
mode adds is the read-only discipline and the grounding depth, not access to the
tool. Doug also distinguishes a *sketch* (a few bullets in chat, for work
happening now) from a *plan* (this file, for a fresh session), and says which one
it's offering. Edit modes and their boot default are detailed under
[What shapes doug's behavior](#what-shapes-dougs-behavior); race modes override
them all.

`/rewind` deliberately rewinds **context only, never the working tree.** The
expensive part of a wrong turn isn't the diff — it's that the thread now carries
a direction doug will keep leaning on, so every correction fights it. Moving the
session leaf back deletes that gravity outright; the branch is still in the tree
(`/tree`) if you want it. Reverting files is left to you, because a rewind that
silently undid edits would be worse than one that doesn't: doug's context and
your repo would disagree with nobody watching. So the confirm names every file
the discarded turns touched and stops there — you have git and, usually, a
watcher already running. Choose "Rewind + leave a note" to keep a one-line
summary of the abandoned path so doug doesn't propose it again.

## What shapes doug's behavior

Filesystem rule: **doug's own files live flat in `~/.doug/`; `~/.doug/agent/`
belongs to the engine** (settings, auth, trust, sessions, the rendered
SYSTEM.md, extension/theme discovery). If doug invented it, it's top-level.

| File | Effect |
|---|---|
| repo `prompts/system.template.md` | doug's identity — rendered with the profile into `~/.doug/agent/SYSTEM.md` on every launch. Includes the verification rules: proof is normally the narrowest command that exercises the change, but where a **test watcher is declared** (see below) doug states a falsifiable expectation instead of running anything |
| `~/.doug/profile.json` | Who doug works for: `name`, `role`, `notes`. Created by first-run onboarding; edit anytime (auto-migrated from the old `agent/` location) |
| `~/.doug/DOUG.md` | The user's global context, CLAUDE.md-style — free markdown appended to the system prompt at render time. Keep it short; anything task-conditional belongs in a skill. (Project-level names are hardcoded: `AGENTS.md`, else `CLAUDE.md` — a project `DOUG.md` won't load) |
| `~/.doug/skills/` | Lazy-loaded knowledge (stack conventions, homelab how-tos): one description line always in context, full body read on demand. Loaded by default — the launcher points pi here via `--skill`, so no settings entry is needed |
| repo `agent/extensions/guardrails.ts` | Bash guardrails: blocks mutative git, secret reads, sudo, catastrophic `rm`; installs/system changes require a live confirm dialog (symlinked to `~/.doug/agent/extensions/`, hot-reload with `/reload`) |
| repo `agent/extensions/flipflop.ts` | Flip-flop detector: a 3rd edit to the same file with the same command re-run between edits (spray-and-pray debugging) triggers a live check-in; blocked outright when running unattended |
| repo `agent/extensions/aliases.ts` | Command aliases for muscle memory from other tools: `/clear` starts a fresh session (pi's built-in `/new`) |
| repo `agent/extensions/rewind.ts` | Backs `/rewind`: walks the session branch to the Nth-last user message, warns which files the discarded turns edited, then `navigateTree`s the leaf back there (optionally leaving a one-line summary of the abandoned direction, labelled `rewound`). Keeps no state of its own — the file list is derived from the session's own tool calls |
| repo `agent/extensions/permissions.ts` | The policy behind the edit modes and plan [commands](#commands). Bash: mutative commands prompt Allow once / Always allow / Deny; "always" persists only the exact command to `~/.doug/permissions.json` (global to all sessions); prefix grants (`allowPrefixes`) work but are hand-edit only; read-only and guardrails-covered commands are exempt. Edits: sessions boot in manual mode — every edit/write prompts Allow / Allow all edits / Deny; the footer shows the current mode. Plan mode is read-only for code — the model persists a plan only through the `save_plan` tool (typed schema requires goal/grounding/steps; you approve before it writes), which is available in every mode so an agreed plan never needs a `/plan` detour to be saved, and `/execute-plan` runs it in a fresh session told to trust the plan as its orientation rather than re-exploring the repo |
| repo `agent/extensions/subagent/` | Vendored from pi's `examples/extensions/subagent` (see `MAINTAINING.md`). Registers a `subagent` tool that spawns an isolated child `pi` process per task, single/parallel/chain modes, output capped at 50KB back to the parent. doug ships one agent (`scout`, read-only recon — see below); its model is resolved by the doug-added `model.ts` (env > `~/.doug/config.json` > frontmatter, see the config row below) |
| `.agents/SYSTEM.md` (in a project) | Replaces the system prompt for that project |
| `.agents/APPEND_SYSTEM.md` (in a project) | Appends to the system prompt instead of replacing |
| `AGENTS.md` / `CLAUDE.md` (in a project) | Project context, loaded from cwd and ancestors; `AGENTS.md` shadows `CLAUDE.md` in the same directory. Declaring a **test watcher** here (e.g. "Tests: guard runs continuously — don't run rspec yourself") flips doug's verification from executing tests to naming the expected result, which is what you want when you're already watching the output |
| `~/.doug/config.json` | doug's own config (pi never reads it): `editMode: "manual" \| "auto"` sets the boot default for edit approvals (manual if absent); `agentModels: { "<name>": "<model>" }` pins a persisted model per subagent (e.g. `{"agentModels": {"scout": "claude-haiku-4-5"}}`) — `DOUG_<AGENT_NAME>_MODEL` overrides it for a single run, unset falls through to the agent's frontmatter `model`, then to inheriting doug's own model |
| `~/.doug/agent/settings.json` | Model, theme, keybindings, enabled extensions (`/settings` in the TUI) |
| `~/.doug/agent/{tools,prompts,themes}/` | Global custom tools, prompt templates, themes |
| `~/.doug/agent/agents/` (symlink to repo `agent/agents/`) | Subagent definitions for `agent/extensions/subagent/` — markdown with YAML frontmatter (`name`, `description`, `tools`, optional `model`). Ships `scout.md` (read-only recon) |
| `.agents/{skills,prompts,themes,extensions}/` | Same, scoped to one project |
| `~/.doug/plans/<project>/` | Plan-mode output: `<date>-<slug>.md` files (written by `save_plan`) plus a sibling `.state.json` tracking each plan's written/dispatched lifecycle. Kept in the home dir (namespaced by project dir name) so no repo has to gitignore scratch plans; `/execute-plan` scopes to the current project and defaults to the newest un-dispatched plan. Plans are grounded in one repo's `file:line` refs |
| `~/.doug/tmp/<timestamp>-<pid>/` | Per-launch scratch dir (see [Prompt placeholders](#prompt-placeholders), `{{scratch_dir}}`). Dirs older than 7 days are pruned automatically at launch, except one whose `.lock` file names a still-running PID — so a long-held session keeps its scratch dir past the 7-day cutoff |
| `~/.doug/agent/models.json` | Custom model/provider catalog |
| `~/.doug/agent/auth.json` | Provider credentials (machine-local, never in this repo) |
| `patches/` | Cosmetic branding patch applied to the vendored pi on `npm install` |

Precedence for identity: the rendered `~/.doug/agent/SYSTEM.md` (template +
profile) applies globally; a project's `.agents/SYSTEM.md` replaces it for that
project. Extensions/skills install via `doug install <source>` (pi's extension
ecosystem, unchanged).

## Custom skills

Skills are lazy-loaded: only the frontmatter `description` sits in context
(one line per skill); the body is read when a task matches it, or forced with
`/skill:<name>`. A skill is a directory under `~/.doug/skills/` with a
`SKILL.md` (helper scripts/references sit beside it):

```markdown
# ~/.doug/skills/rails/SKILL.md
---
name: rails
description: Rails conventions — load before editing .rb files or writing migrations, specs, or controllers
---
<the actual conventions>
```

`~/.doug/skills/` is a default resolution path — the launcher passes it to pi
as `--skill`, so nothing needs adding to settings. The one requirement is the
`description`: write it as a "load when …" trigger — it is the only thing doug
sees before deciding to read the body, so a vague description means the skill
never fires. Additional paths auto-discover with no config: project skills
under `.doug/skills/` (on project trust) and vendor-neutral `~/.agents/skills/`.
`--skill` is additive, so none of these are shadowed by the default.

## Maintaining doug

Building doug, the branding patch, upgrading the vendored pi, node resolution,
and repo layout live in [MAINTAINING.md](MAINTAINING.md).
