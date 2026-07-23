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
- `agent/SYSTEM.template.md` is doug's identity/system prompt, with
  `{{name}}`/`{{about}}` placeholders. On every launch the launcher renders it
  with `~/.doug/profile.json` into `~/.doug/agent/SYSTEM.md`, where pi
  picks it up as a full system-prompt replacement. Missing profile on an
  interactive first run triggers a short onboarding prompt; non-interactive
  runs fall back to "the user". Edit template or profile; both take effect on
  the next launch.

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
all). Every one is handled in-process by the permissions extension — no model
loop:

| Command | What it does |
|---|---|
| `/manual` | Require live approval for every edit — doug's boot default (footer ✋). |
| `/auto` | Allow all edits for the rest of the session (footer ✏️); `/manual` to go back. |
| `/plan` | Enter plan mode: discuss and ground a change while all code edits/writes are blocked. `/plan deep` asks for a comprehensive plan; either is switchable mid-plan (footer 📋 / 📋·deep). |
| `/execute-plan [name]` | Run a saved plan in a fresh session — newest un-dispatched by default, or a named match. Confirms (name + age + status) before starting. |
| `/plans` | List this project's saved plans and their written/dispatched status. Never executes anything. |

Plans are written by the model calling the `save_plan` tool (plan mode only) —
its typed schema requires goal/grounding/steps, and doug asks you to approve
(Save / Not yet / Push back) before anything lands on disk. Edit modes and their
boot default are detailed under
[What shapes doug's behavior](#what-shapes-dougs-behavior); race modes override
them all.

## What shapes doug's behavior

Filesystem rule: **doug's own files live flat in `~/.doug/`; `~/.doug/agent/`
belongs to the engine** (settings, auth, trust, sessions, the rendered
SYSTEM.md, extension/theme discovery). If doug invented it, it's top-level.

| File | Effect |
|---|---|
| repo `agent/SYSTEM.template.md` | doug's identity — rendered with the profile into `~/.doug/agent/SYSTEM.md` on every launch |
| `~/.doug/profile.json` | Who doug works for: `name`, `role`, `notes`. Created by first-run onboarding; edit anytime (auto-migrated from the old `agent/` location) |
| `~/.doug/DOUG.md` | The user's global context, CLAUDE.md-style — free markdown appended to the system prompt at render time. Keep it short; anything task-conditional belongs in a skill. (Project-level names are hardcoded: `AGENTS.md`, else `CLAUDE.md` — a project `DOUG.md` won't load) |
| `~/.doug/skills/` | Lazy-loaded knowledge (stack conventions, homelab how-tos): one description line always in context, full body read on demand. Loaded by default — the launcher points pi here via `--skill`, so no settings entry is needed |
| repo `agent/extensions/guardrails.ts` | Bash guardrails: blocks mutative git, secret reads, sudo, catastrophic `rm`; installs/system changes require a live confirm dialog (symlinked to `~/.doug/agent/extensions/`, hot-reload with `/reload`) |
| repo `agent/extensions/flipflop.ts` | Flip-flop detector: a 3rd edit to the same file with the same command re-run between edits (spray-and-pray debugging) triggers a live check-in; blocked outright when running unattended |
| repo `agent/extensions/permissions.ts` | The policy behind the edit modes and plan [commands](#commands). Bash: mutative commands prompt Allow once / Always allow / Deny; "always" persists only the exact command to `~/.doug/permissions.json` (global to all sessions); prefix grants (`allowPrefixes`) work but are hand-edit only; read-only and guardrails-covered commands are exempt. Edits: sessions boot in manual mode — every edit/write prompts Allow / Allow all edits / Deny; the footer shows the current mode. Plan mode is read-only for code — the model persists a plan only through the `save_plan` tool (typed schema requires goal/grounding/steps; you approve before it writes), and `/execute-plan` runs it in a fresh session told to trust the plan as its orientation rather than re-exploring the repo |
| `.agents/SYSTEM.md` (in a project) | Replaces the system prompt for that project |
| `.agents/APPEND_SYSTEM.md` (in a project) | Appends to the system prompt instead of replacing |
| `AGENTS.md` / `CLAUDE.md` (in a project) | Project context, loaded from cwd and ancestors; `AGENTS.md` shadows `CLAUDE.md` in the same directory |
| `~/.doug/config.json` | doug's own config (pi never reads it): `editMode: "manual" \| "auto"` sets the boot default for edit approvals (manual if absent) |
| `~/.doug/agent/settings.json` | Model, theme, keybindings, enabled extensions (`/settings` in the TUI) |
| `~/.doug/agent/{tools,prompts,themes}/` | Global custom tools, prompt templates, themes |
| `.agents/{skills,prompts,themes,extensions}/` | Same, scoped to one project |
| `~/.doug/plans/<project>/` | Plan-mode output: `<date>-<slug>.md` files (written by `save_plan`) plus a sibling `.state.json` tracking each plan's written/dispatched lifecycle. Kept in the home dir (namespaced by project dir name) so no repo has to gitignore scratch plans; `/execute-plan` scopes to the current project and defaults to the newest un-dispatched plan. Plans are grounded in one repo's `file:line` refs |
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
