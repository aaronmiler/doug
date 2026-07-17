# doug

```
     █
    ███
   █████
    ███
  ███████
   █████
 █████████
     █
     █

 doug
```

An opinionated personal coding assistant. Doug is a branded distribution of
[pi](https://github.com/earendil-works/pi-mono), built on pi's official
rebranding mechanism — no fork, no global installs: pi is vendored and
pinned in-repo, modified only by one small cosmetic patch
(see [Branding patches](#branding-patches)).
He learns who you are on first run, keeps his identity in a version-controlled
template, and enforces a clear line between his tasks and yours.

## How it works

- pi is **vendored**: pinned in this repo's `package.json` + lockfile and
  installed into the repo's `node_modules`. Doug depends on nothing global.
- `bin/doug` regenerates a shim package dir at `~/.doug/shim` on every launch:
  the vendored pi's `package.json` patched with
  `piConfig: { name: "doug", configDir: ".doug" }`, plus symlinks to pi's
  `dist`, `docs`, `examples`, `README.md`, and `CHANGELOG.md`.
- It points `PI_PACKAGE_DIR` at the shim and runs the vendored pi. pi reads
  its branding from there, so the banner, config dir (`~/.doug`), project
  config dir (`.doug/`), and env vars (`DOUG_CODING_AGENT_DIR`, ...) all
  become doug's.
- `agent/SYSTEM.template.md` is Doug's identity/system prompt, with
  `{{name}}`/`{{about}}` placeholders. On every launch the launcher renders it
  with `~/.doug/agent/profile.json` into `~/.doug/agent/SYSTEM.md`, where pi
  picks it up as a full system-prompt replacement. Missing profile on an
  interactive first run triggers a short onboarding prompt; non-interactive
  runs fall back to "the user". Edit template or profile; both take effect on
  the next launch.

## Install

Prerequisites: node >= 22.19 reachable (mise install or PATH), `~/.local/bin`
on PATH.

```bash
./install.sh   # vendors pi (npm ci + branding patches), symlinks doug onto PATH
doug           # first run: onboarding (profile.json), then /login for a provider
npm test       # optional: run the guardrails test suite
```

## Branding patches

pi's TUI header is hardcoded (π wordmark, "Pi can explain…" startup line), so
`patches/` carries a small [patch-package](https://github.com/ds300/patch-package)
patch applied by `postinstall`: the Douglas-fir boot mark with wordmark and
keybinding hints inlined beside it (stacking on narrow terminals), and
Doug-flavored startup text. That's the only place pi's code is modified.

## Upgrading pi

Bump the version in `package.json`, then `npm install`. The shim is rebuilt on
every launch, so no other step exists. (`doug update` self-update is
intentionally inert — upgrades go through the lockfile.) If the branding patch
no longer applies after a bump, patch-package will say so loudly — re-make the
two-string patch against the new version and `npx patch-package
@earendil-works/pi-coding-agent`.

## What shapes Doug's behavior

| File | Effect |
|---|---|
| repo `agent/SYSTEM.template.md` | Doug's identity — rendered with the profile into `~/.doug/agent/SYSTEM.md` on every launch |
| `~/.doug/agent/profile.json` | Who doug works for: `name`, `role`, `notes`. Created by first-run onboarding; edit anytime |
| repo `agent/extensions/guardrails.ts` | Bash guardrails: blocks mutative git, secret reads, sudo, `tars deploy`, catastrophic `rm`; installs/system changes require a live confirm dialog (symlinked to `~/.doug/agent/extensions/`, hot-reload with `/reload`) |
| `.doug/SYSTEM.md` (in a project) | Replaces the system prompt for that project |
| `.doug/APPEND_SYSTEM.md` (in a project) | Appends to the system prompt instead of replacing |
| `AGENTS.md` (in a project) | Project context appended to every prompt |
| `~/.doug/agent/settings.json` | Model, theme, keybindings, enabled extensions (`/settings` in the TUI) |
| `~/.doug/agent/{tools,prompts,themes}/` | Global custom tools, prompt templates, themes |
| `.doug/{skills,prompts,themes,extensions}/` | Same, scoped to one project |
| `~/.doug/agent/models.json` | Custom model/provider catalog |
| `~/.doug/agent/auth.json` | Provider credentials (machine-local, never in this repo) |
| `patches/` | Cosmetic branding patch applied to the vendored pi on `npm install` |

Precedence for identity: the rendered `~/.doug/agent/SYSTEM.md` (template +
profile) applies globally; a project's `.doug/SYSTEM.md` replaces it for that
project. Extensions/skills install via `doug install <source>` (pi's extension
ecosystem, unchanged).

## Node versions (mise)

pi needs node >=22.19, but a project's `.node-version` can activate anything.
The launcher never trusts the project-activated node: it picks the newest node
under `~/.local/share/mise/installs/node/` (falling back to PATH's node only
if mise has none). Doug therefore behaves identically in every directory,
regardless of what node the project pins.

## Layout

```
bin/doug                    launcher (shim, profile onboarding, template render)
agent/SYSTEM.template.md    Doug's identity template (rendered with profile.json)
agent/extensions/           guardrails + future doug extensions (symlinked)
patches/                    cosmetic branding patch for the vendored pi
test/guardrails.test.ts     guardrails behavioral suite (npm test)
install.sh                  vendors pi + puts `doug` on PATH
```
