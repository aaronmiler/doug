#!/usr/bin/env node
// Dev preview for doug themes: renders each token as a color swatch + sample
// text, with a legibility contrast ratio against the theme's intended bg.
//   node agent/themes/preview.mjs [name...]   (default: all doug-*.json here)
// ANSI 0-15 render via YOUR terminal's palette (as pi does), so run it in the
// terminal + scheme you're targeting. 16-255 are fixed; contrast is shown only
// for those and hex (0-15 are terminal-defined, so N/A).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const names = process.argv.slice(2).length
  ? process.argv.slice(2).map((n) => n.replace(/\.json$/, ""))
  : readdirSync(DIR).filter((f) => f.startsWith("doug-") && f.endsWith(".json")).map((f) => f.slice(0, -5));

const cube = (i) => (i === 0 ? 0 : 55 + i * 40);
const idxToHex = (n) => {
  if (n < 16) return null; // terminal-defined
  if (n < 232) { const c = n - 16; return [cube(Math.floor(c / 36) % 6), cube(Math.floor(c / 6) % 6), cube(c % 6)]; }
  const v = 8 + (n - 232) * 10; return [v, v, v];
};
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgb = (v) => (typeof v === "number" ? idxToHex(v) : /^#/.test(v) ? hexToRgb(v) : null);
const lum = ([r, g, b]) => { const c = [r, g, b].map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

const fg = (v) => (typeof v === "number" ? `\x1b[38;5;${v}m` : `\x1b[38;2;${hexToRgb(v).join(";")}m`);
const bg = (v) => (typeof v === "number" ? `\x1b[48;5;${v}m` : `\x1b[48;2;${hexToRgb(v).join(";")}m`);
const R = "\x1b[0m";

for (const name of names) {
  let t;
  try { t = JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")); } catch (e) { console.error(`skip ${name}: ${e.message}`); continue; }
  const resolve = (v) => (typeof v === "string" && v in (t.vars || {}) ? t.vars[v] : v);
  const pageBg = t.export?.pageBg;
  console.log(`\n${name}  (bg ${pageBg ?? "?"})\n${"─".repeat(64)}`);
  for (const [tok, raw] of Object.entries(t.colors)) {
    const v = resolve(raw);
    let swatch = "        ", sample = "Sample text  ", note = "";
    if (v === "") { note = "terminal default fg"; sample = ""; }
    else { swatch = `${bg(v)}        ${R}`; sample = `${fg(v)}Sample text${R}`; }
    if (v !== "" && pageBg) {
      const cv = rgb(v);
      note = cv ? `${contrast(cv, hexToRgb(pageBg)).toFixed(2)}:1` : "ansi (terminal-defined)";
    }
    console.log(`  ${swatch}  ${tok.padEnd(20)} ${sample.padEnd(24)} ${note}`);
  }
}
