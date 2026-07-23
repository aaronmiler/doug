# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What doug is

doug is a **branded distribution of [pi](https://github.com/earendil-works/pi-mono)**, not a fork. pi is vendored (pinned in `package.json` + lockfile, installed into this repo's `node_modules`) and modified only by one cosmetic branding patch. doug's own behavior is layered on top via pi's official rebranding mechanism (`piConfig`), a launcher script, and three pi extensions. There is no application framework here to learn — the value lives in the launcher, the extensions, and the identity template.

Read `README.md` first — it is the architecture source of truth (how vendoring works, what every config file does, the command list). `MAINTAINING.md` covers the build, the branding patch, and pi upgrades.

## Commands

```bash
./install.sh                       # vendor pi (npm ci + branding patch) + symlink `doug` onto PATH
npm test                           # run all guardrail suites (test/*.test.ts)
node --experimental-strip-types --no-warnings test/permissions.test.ts   # run ONE suite
scripts/check-pi-upgrade.sh 0.82.0 # dry-run a pi bump in a throwaway sandbox (does not touch the install)
scripts/bump-pi.sh 0.82.0          # actually bump pi: move the pin + patch filename in lockstep, reinstall
```

There is no build step and no linter. Tests are plain `node --experimental-strip-types` scripts (no test framework) that exercise the extensions directly; `npm test` loops over `test/*.test.ts` and exits on the first failure.

## Architecture

Three pieces do all the work:

1. **`bin/doug` (the launcher)** — regenerates the shim at `~/.doug/shim` on every launch (vendored pi's `package.json` patched with `piConfig: { name: "doug", configDir: ".agents" }` + symlinks to pi's `dist`/`docs`/etc.), points `PI_PACKAGE_DIR` at it, and runs the vendored pi. It also: resolves a satisfying node (`DOUG_NODE` → PATH → version managers), renders the identity template into `~/.doug/agent/SYSTEM.md`, runs first-run profile onboarding, handles doug's own subcommands (`update`, `--version`) before pi sees them, and translates `--push`/`--flat-out` race-mode flags into `DOUG_PUSH`/`DOUG_FLAT_OUT` env vars.

2. **`agent/extensions/*.ts` (pi extensions)** — symlinked into `~/.doug/agent/extensions/` at install; hot-reload with `/reload`. They read repo-relative files at runtime via `DOUG_REPO_DIR` (exported by `bin/doug`), so they resolve `prompts/` without guessing.
   - `permissions.ts` — the biggest piece. Backs the edit modes and plan commands (`/manual` `/auto` `/plan` `/execute-plan` `/plans`), the bash Allow-once/Always/Deny prompts, and the `save_plan` tool. Persists to `~/.doug/permissions.json` and `~/.doug/config.json`.
   - `guardrails.ts` — hard bash blocks: mutative git, secret reads, sudo, catastrophic `rm`; installs/system changes require a live confirm.
   - `flipflop.ts` — detects spray-and-pray debugging (a 3rd edit to the same file with the same command re-run between edits) and forces a human check-in.

3. **`prompts/*.template.md` (identity + plan prompts)** — `system.template.md` is doug's system prompt with `{{name}}`/`{{about}}` placeholders, rendered against `~/.doug/profile.json` on every launch. `plan-mode.template.md` is loaded by `permissions.ts` with `{{user}}`/`{{depth_note}}` substitution.

### Runtime layout (not in this repo)

doug's own files live **flat in `~/.doug/`**; **`~/.doug/agent/` belongs to the pi engine** (settings, auth, sessions, the rendered `SYSTEM.md`, extension/theme discovery). If doug invented it (`profile.json`, `config.json`, `permissions.json`, `DOUG.md`, `skills/`, `plans/`), it's top-level. See the config table in `README.md` for what each file does.

## Conventions specific to this repo

- **Docs are the contract.** README and MAINTAINING describe doug's behavior in detail and are treated as source of truth; when you change launcher/extension behavior, update the matching table row or section in the same change.
- **Extensions read the repo, not their symlink target.** New repo-relative file reads in an extension must resolve through `DOUG_REPO_DIR` (with a `../..` fallback), matching `permissions.ts`. Don't assume the extension runs from inside the repo.
- **Never edit `node_modules/@earendil-works/pi-coding-agent` directly** to change pi behavior. The only sanctioned modification is the branding patch under `patches/`; pi upgrades go through `scripts/bump-pi.sh`, which keeps the `package.json` pin and the version-stamped patch filename in lockstep (patch-package silently skips a version-less patch name).
