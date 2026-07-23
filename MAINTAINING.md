# Maintaining doug

How doug is built and kept current — vendoring, the branding patch, pi upgrades,
and node resolution. For installing and using doug, see the [README](README.md);
its [How it works](README.md#how-it-works) section covers the vendoring
architecture these notes assume.

## Repo layout

```
bin/doug                    launcher (shim, profile onboarding, template render)
prompts/system.template.md  doug's identity template (rendered with profile.json)
prompts/plan-mode.template.md  plan-mode prompt (loaded by the permissions extension)
agent/extensions/           guardrails + future doug extensions (symlinked)
patches/                    cosmetic branding patch for the vendored pi
scripts/bump-pi.sh          bump pi: pin + patch rename + reinstall, in one step
scripts/check-pi-upgrade.sh dry-run a pi bump in a throwaway sandbox
test/guardrails.test.ts     guardrails behavioral suite (npm test)
install.sh                  vendors pi + puts `doug` on PATH
bootstrap.sh                curl-able: clone (or pull) the repo, then install.sh
```

## Branding patches

pi's TUI header is hardcoded (π wordmark, "Pi can explain…" startup line), so
`patches/` carries a small [patch-package](https://github.com/ds300/patch-package)
patch applied by `postinstall`: the doug-fir boot mark with wordmark and
keybinding hints inlined beside it (stacking on narrow terminals), and
doug-flavored startup text. That's the only place pi's code is modified.

## Upgrading pi

One command does the whole bump — it moves the `package.json` pin and the patch
filename together, then reinstalls:

```bash
scripts/bump-pi.sh 0.82.0             # dry-run check, then bump
scripts/bump-pi.sh --no-check 0.82.0  # skip the check (already ran it)
```

The coupling `bump-pi.sh` exists to handle: pi is pinned in `package.json` and
carries one patch named `patches/@earendil-works+pi-coding-agent+<ver>.patch`, and
patch-package **requires** the version in that filename (a version-less name is
silently skipped), so package.json and the patch must move in lockstep. By default
`bump-pi.sh` first dry-runs the bump in a throwaway sandbox (see below) and aborts,
tree untouched, if the patch won't apply; otherwise it renames the patch, rewrites
the pin, and runs `npm install`. The shim is rebuilt on every launch, so there's no
further step. (`doug update` updates doug itself, not pi — pi upgrades go through
this lockfile change.)

If the patch no longer applies — pi refactored the region it touches — refresh it
against the new code before bumping: install the target in a scratch checkout,
re-apply the two-string edit to
`node_modules/@earendil-works/pi-coding-agent/dist/…`, run `npx patch-package
@earendil-works/pi-coding-agent`, rename the result to `+<ver>.patch`, then finish
with `bump-pi.sh --no-check <ver>`.

### Checking a bump without doing it

`bump-pi.sh` runs this dry-run for you, but it also stands alone when you just want
to know whether a version is safe to adopt:

```bash
scripts/check-pi-upgrade.sh          # target = pi.dev latest
scripts/check-pi-upgrade.sh 0.81.0   # target = an explicit version
```

It installs the target pi in a throwaway sandbox and runs `patch-package` there
exactly as `install.sh` would, without touching the real install. A ✅ means the
branding patch still applies and the bump is safe (it prints the two lines to
change); a ❌ means pi refactored the region the patch touches, so refresh the
patch against the new code first.

doug also suppresses pi's own startup version nag — `bin/doug` exports
`PI_SKIP_VERSION_CHECK=1` so pi never phones home on launch; upgrades here are
deliberate, not reactive. Re-enable the nag for one run with an empty value:
`PI_SKIP_VERSION_CHECK= doug …` (pi treats any non-empty value as "skip", so use
the empty string, not `0`).

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
