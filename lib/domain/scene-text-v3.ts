/**
 * Text measurement for Focus 3. Independent of scene-text.ts (DejaVu) so that
 * focus-v1/v2 keep their metrics untouched.
 *
 * - Two families: "sans" (IBM Plex Sans, regular + semibold) and "mono" (IBM Plex Mono medium).
 * - Tracking is part of the measurement: width = Σ advance + (n − 1) · tracking · size.
 * - wrap() splits on ASCII spaces only, so words joined with U+00A0 by glue() stay together.
 * - Metrics are advance widths without kerning: measurements are conservative.
 */
import metrics from "./font-metrics-plex.json";

export type Font = "sans" | "mono";

type Table = Record<string, number>;
const M = metrics as {
  family: { sans: string; mono: string };
  vertical: Record<Font, { ascent: number; descent: number; capHeight: number; xHeight: number }>;
  widths: { "sans-regular": Table; "sans-bold": Table; mono: Table };
};

function table(font: Font, bold: boolean): Table {
  return font === "mono" ? M.widths.mono : bold ? M.widths["sans-bold"] : M.widths["sans-regular"];
}

export function measure(text: string, size: number, font: Font = "sans", bold = false, tracking = 0): number {
  const t = table(font, bold);
  const chars = Array.from(text);
  let w = 0;
  for (const c of chars) w += (t[String(c.codePointAt(0))] ?? (font === "mono" ? 0.6 : 0.62)) * size;
  return w + Math.max(0, chars.length - 1) * tracking * size;
}

/** Baseline offset from the top of a line box, in px, for a given size and line-height. */
export function baseline(size: number, lineHeight: number, font: Font = "sans"): number {
  const v = M.vertical[font];
  const content = v.ascent + v.descent;               // em
  const halfLeading = (lineHeight - content) / 2;     // em, may be negative
  return (halfLeading + v.ascent) * size;
}

const SHORT = "в во с со и а к ко о об от до за на не ни но по из у же ли бы для при без над под про";
const SHORT_RE = new RegExp(`(^|[\\s(«])(${SHORT.split(" ").map((w) => `${w}|${w[0].toUpperCase()}${w.slice(1)}`).join("|")}) `, "g");

/** Russian micro-typography: glue short prepositions/conjunctions to the next word and the dash to the previous one. */
export function glue(text: string): string {
  let out = text.replace(SHORT_RE, "$1$2 ");
  out = out.replace(SHORT_RE, "$1$2 "); // second pass catches back-to-back short words ("и в")
  out = out.replace(/ — /g, " — ");
  return out;
}

export function upper(text: string): string {
  return text.toLocaleUpperCase("ru-RU");
}

export function wrap(text: string, maxWidth: number, size: number, font: Font = "sans", bold = false, tracking = 0): string[] {
  const lines: string[] = [];
  for (const paragraph of glue(text).split("\n")) {
    if (!paragraph.trim()) { lines.push(""); continue; }
    let line = "";
    for (const token of paragraph.split(" ").filter(Boolean)) {
      const trial = line ? `${line} ${token}` : token;
      if (measure(trial, size, font, bold, tracking) <= maxWidth) { line = trial; continue; }
      if (line) { lines.push(line); line = ""; }
      if (measure(token, size, font, bold, tracking) <= maxWidth) { line = token; continue; }
      // Token wider than the box: break by characters (last resort, flagged by the caller via width check).
      for (const ch of Array.from(token)) {
        if (measure(line + ch, size, font, bold, tracking) > maxWidth && line) { lines.push(line); line = ""; }
        line += ch;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** A line-broken, measured block ready to be placed. */
export type TextBlock = {
  lines: string[];
  widths: number[];
  size: number;
  lineHeight: number;      // px per line
  height: number;          // px
  maxWidth: number;        // widest line, px
  font: Font;
  bold: boolean;
  tracking: number;
  overflow: boolean;       // a single token did not fit the box
};

export function block(text: string, boxWidth: number, size: number, lineHeight: number, font: Font = "sans", bold = false, tracking = 0, balance = false): TextBlock {
  let lines = wrap(text, boxWidth, size, font, bold, tracking);
  if (balance && lines.length >= 2 && !text.includes("\n")) {
    // CSS `text-wrap: balance` equivalent: the narrowest box that still gives the same number of lines.
    const n = lines.length;
    let lo = Math.max(...glue(text).split(" ").map((t) => measure(t, size, font, bold, tracking))), hi = boxWidth;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (wrap(text, mid, size, font, bold, tracking).length <= n) hi = mid; else lo = mid;
    }
    lines = wrap(text, hi, size, font, bold, tracking);
  }
  const widths = lines.map((l) => measure(l, size, font, bold, tracking));
  const lh = size * lineHeight;
  return {
    lines, widths, size, lineHeight: lh, height: lines.length * lh,
    maxWidth: Math.max(0, ...widths), font, bold, tracking,
    overflow: widths.some((w) => w > boxWidth + 0.5) || glue(text).split(/[ \n]+/).some(token => measure(token, size, font, bold, tracking) > boxWidth + 0.5),
  };
}
