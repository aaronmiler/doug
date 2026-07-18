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
(see [Branding patches](#branding-patches)).
He learns who you are on first run, keeps his identity in a version-controlled
template, and enforces a clear line between his tasks and yours.

## How it works

- pi is **vendored**: pinned in this repo's `package.json` + lockfile and
  installed into the repo's `node_modules`. doug depends on nothing global.
- `bin/doug` regenerates a shim package dir at `~/.doug/shim` on every launch:
  the vendored pi's `package.json` patched with
  `piConfig: { name: "doug", configDir: ".doug" }`, plus symlinks to pi's
  `dist`, `docs`, `examples`, `README.md`, and `CHANGELOG.md`.
- It points `PI_PACKAGE_DIR` at the shim and runs the vendored pi. pi reads
  its branding from there, so the banner, config dir (`~/.doug`), project
  config dir (`.doug/`), and env vars (`DOUG_CODING_AGENT_DIR`, ...) all
  become doug's.
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

## Branding patches

pi's TUI header is hardcoded (π wordmark, "Pi can explain…" startup line), so
`patches/` carries a small [patch-package](https://github.com/ds300/patch-package)
patch applied by `postinstall`: the doug-fir boot mark with wordmark and
keybinding hints inlined beside it (stacking on narrow terminals), and
doug-flavored startup text. That's the only place pi's code is modified.

## Upgrading pi

Bump the version in `package.json`, then `npm install`. The shim is rebuilt on
every launch, so no other step exists. (`doug update` updates doug itself, not
pi — pi upgrades go through the lockfile.) If the branding patch
no longer applies after a bump, patch-package will say so loudly — re-make the
two-string patch against the new version and `npx patch-package
@earendil-works/pi-coding-agent`.

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
| repo `agent/extensions/permissions.ts` | Permission prompts. Bash: mutative commands prompt Allow once / Always allow / Deny; "always" persists only the exact command to `~/.doug/permissions.json` (global to all sessions); prefix grants (`allowPrefixes`) work but are hand-edit only; read-only and guardrails-covered commands are exempt. Edits: sessions boot in manual mode — every edit/write prompts Allow / Allow all edits / Deny; `/manual` and `/auto` hop modes; the footer status shows the current mode. Plan mode: `/plan` enters a read-only discuss-and-ground phase (only `.doug/plans/` is writable, planning instructions injected per-turn); `/execute-plan [name]` starts a fresh session seeded with just the plan file |
| `.doug/SYSTEM.md` (in a project) | Replaces the system prompt for that project |
| `.doug/APPEND_SYSTEM.md` (in a project) | Appends to the system prompt instead of replacing |
| `AGENTS.md` / `CLAUDE.md` (in a project) | Project context, loaded from cwd and ancestors; `AGENTS.md` shadows `CLAUDE.md` in the same directory |
| `~/.doug/config.json` | doug's own config (pi never reads it): `editMode: "manual" \| "auto"` sets the boot default for edit approvals (manual if absent) |
| `~/.doug/agent/settings.json` | Model, theme, keybindings, enabled extensions (`/settings` in the TUI) |
| `~/.doug/agent/{tools,prompts,themes}/` | Global custom tools, prompt templates, themes |
| `.doug/{skills,prompts,themes,extensions}/` | Same, scoped to one project |
| `.doug/plans/` (in a project) | Plan-mode output: `<date>-<slug>.md` files written during `/plan`, consumed by `/execute-plan`. Project-scoped on purpose — plans are grounded in one repo's `file:line` refs |
| `~/.doug/agent/models.json` | Custom model/provider catalog |
| `~/.doug/agent/auth.json` | Provider credentials (machine-local, never in this repo) |
| `patches/` | Cosmetic branding patch applied to the vendored pi on `npm install` |

Precedence for identity: the rendered `~/.doug/agent/SYSTEM.md` (template +
profile) applies globally; a project's `.doug/SYSTEM.md` replaces it for that
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

## Node resolution

pi declares its floor in `engines` (currently >=22.19), and the launcher reads
it from there — the requirement is a version, not a tool. Resolution order:

1. `DOUG_NODE` — explicit override; fails loudly if it doesn't satisfy.
2. PATH's node, when it satisfies — whatever put it there (brew, nvm, a
   project's pin) is fine.
3. The newest install found under common version managers (mise, nvm, fnm,
   asdf, volta), so a project whose `.node-version` pins an old node never
   breaks doug.

If nothing satisfies, doug says what it needs and every way to get it —
no manager is ever required.

## Layout

```
bin/doug                    launcher (shim, profile onboarding, template render)
agent/SYSTEM.template.md    doug's identity template (rendered with profile.json)
agent/extensions/           guardrails + future doug extensions (symlinked)
patches/                    cosmetic branding patch for the vendored pi
test/guardrails.test.ts     guardrails behavioral suite (npm test)
install.sh                  vendors pi + puts `doug` on PATH
bootstrap.sh                curl-able: clone (or pull) the repo, then install.sh
```
