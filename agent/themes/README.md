# doug themes

pi TUI themes for doug. `bin/doug` symlinks this directory to
`~/.doug/agent/themes`. Themes hot-reload on edit.

## The pair: `doug-light` + `doug-dark`

doug ships a **light/dark pair** wired for automatic switching. Set it in
`~/.doug/agent/settings.json`:

```json
{ "theme": "doug-light/doug-dark" }
```

The `/` is pi's auto-pair syntax (`light/dark`). pi detects the terminal
background and picks the matching side, and — via `onTerminalColorSchemeChange`
— **re-picks live when you flip your terminal between light and dark**, no
relaunch. `bin/doug` seeds this pairing for fresh installs.

> Note: the `/settings` theme picker sets a *single* theme and turns auto-sync
> off. To keep the live light/dark switching, set the paired value in
> `settings.json` directly.

## Philosophy: 90% your terminal, 10% doug

These aren't full color schemes — they're a thin identity layer over *your*
terminal:

- **~90% inherited** — `text` and most foreground use `""` (terminal default)
  or ANSI indices `0–15`, which pi renders as `\x1b[38;5;n]m` and *your*
  terminal theme colors. So doug looks like your Solarized (or gruvbox, nord…)
  and re-themes when your terminal does. The 8 ANSI accents (`1–6`) need no
  per-variant tuning — your scheme already tuned them for both its backgrounds.
- **Neutral grays** (`muted`/`dim`/`thinkingText`) use the fixed 256 grayscale
  ramp (`232–255`), which isn't terminal-remapped. The ramp inverts by
  background — dark variants use higher indices, light variants lower — so each
  variant picks grays legible on its own background.
- **~10% doug thumb** — Cascadia Doug-flag identity on a few strategic tokens:

  | Token | light | dark | Role |
  |-------|-------|------|------|
  | `accent` | `#046A38` | `#1FA05C` | logo, **boot tree**, cursor, selection |
  | `borderAccent` | `#1F6FD4` | `#418FDE` | highlighted/focus borders |
  | `mdListBullet` / `customMessageLabel` | green | green | bullets, doug's labels |

  Green is a **fixed hex, not ANSI `2`** — inheriting the terminal green would
  make the tree olive under Solarized. It's canonical Portland Green `#046A38`
  on light; on dark that's too dark (2.2:1), so it's lightened to `#1FA05C`
  (Cascadia's dark-mode override guidance). Same idea, tuned per background.

## Thinking vs. answer text

Two independent signals: pi renders thinking *italic* (answers upright), **and**
`text` (terminal fg) is brighter than `thinkingText`. Never set `thinkingText`
equal to `text` (indistinguishable) or down to `dim` (unreadable).

## Dev preview

```
node agent/themes/preview.mjs [name...]      # default: all doug-*.json
```

Renders every token as a swatch + sample text with a contrast ratio vs the
theme's intended background. ANSI `0–15` render via *your* terminal's palette
(as pi does), so run it in the terminal + scheme you're tuning for; contrast is
shown only for fixed colors (`16–255` and hex), since `0–15` are
terminal-defined.
