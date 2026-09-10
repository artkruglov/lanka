/**
 * Focus 3 — «редакционный». Deterministic scene for browser, PDF and PPTX.
 *
 * Differences from focus-v2.ts that matter for the exporters:
 *  - text primitives carry `font` ("sans" | "mono") and `tracking` (em); see scene.ts patch.
 *  - nothing sits on a hard-coded y: the title is measured and the evidence block is anchored
 *    to zones.contentBottom; the cover anchors the title above the lead.
 *  - variants (cols / before-after / options / facts / hero) are chosen here from the content shape.
 *  - the scene also returns `meta` (variant, gap, occupancy, title fill) for design-review.ts.
 */
import type { Brand, Slide } from "./model";
import type { Primitive, Scene } from "./scene";
import tokens from "../../design-packs/focus-v3/tokens.json";
import { block, measure, upper, type Font, type TextBlock } from "./scene-text-v3";

type Role = { size: number; font: Font; bold: boolean; lineHeight: number; tracking: number; upper?: boolean };
const ROLES = tokens.typography.roles as Record<string, Role>;
const G = tokens.grid, Z = tokens.zones, S = tokens.spacing, P = tokens.policy;
const W = tokens.canvas.width, H = tokens.canvas.height;

export type SceneMeta = {
  variant: string;
  titleLines: number;
  titleFill: number;        // widest title line / its box
  contentHeight: number;
  gap: number;              // px between title bottom and content top (poster: chrome → title)
  occupancy: number;        // ink area / frame area, rough
  primaryTextClasses: number;
};

export function focusV3Variant(s: Slide): string {
  switch (s.layout) {
    case "split": return s.comparison ? "before-after" : "options";
    case "metrics": {
      const hero = s.metrics.length > 0 && s.metrics.every((m) => m.sourceId && (Math.abs(m.value) >= 10 || m.unit.includes("%")));
      return hero ? "hero" : "facts";
    }
    case "content": {
      const parts=s.body.split(/\n\s*\n/).filter(p=>p.trim());
      if(parts.length===1)return "lead";
      return s.intent?.role==="evidence"&&parts.length>=2&&parts.length<=4&&parts.every(p=>p.trim().includes("\n"))?"fact-rows":"cols";
    }
    case "steps": return "cols";
    case "table": return s.table && s.table.rows.length >= 2 && s.table.rows.length <= 3
      && s.table.columnRoles?.[0] === "key" && s.table.columnRoles.slice(1).every(r => r === "number")
      && s.table.rows.every(r => r[0].length <= 16 && r.slice(1).every(v => v.length <= 8)) ? "numeric-rows" : "auto";
    case "chart": return s.chart.length >= 2 && s.chart.length <= 4 && s.chart.every(r => r.label.length <= 24) ? "bars-large" : "bars";
    case "image": return "right";
    default: return "default";
  }
}

const col = (i: number, span: number) => ({ x: G.margin + (i - 1) * (G.column + G.gutter), w: span * G.column + (span - 1) * G.gutter });
const spanW = (n: number) => n * G.column + (n - 1) * G.gutter;

function hex(c: string) { return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)); }
function mix(a: string, b: string, t: number) {
  const A = hex(a), B = hex(b);
  return "#" + A.map((v, i) => Math.round(v * (1 - t) + B[i] * t).toString(16).padStart(2, "0")).join("");
}

export function focusV3Scene(slide: Slide, b: Brand, index: number, total: number, fitAttempt = 0, prominentData = true): Scene & { meta: SceneMeta } {
  const s = slide;
  const items: Primitive[] = [];
  let dataRange:Scene["dataRange"];
  let overflow = false;
  let variant = focusV3Variant(s);
  // Previously frozen data objects retain their original recipe unless explicitly versioned.
  if (!prominentData && variant === "numeric-rows") variant = "auto";
  if (!prominentData && variant === "bars-large") variant = "bars";

  // ---------- colours ----------
  const D = tokens.palette.derived;
  const paper = b.paper, ink = b.ink, primary = b.primary, accent = b.accent;
  const muted = mix(paper, ink, D.muted.weight), rule = mix(paper, ink, D.rule.weight);
  const tint = mix(paper, primary, D.tint.weight), cardRule = mix(tint, ink, D.cardRule.weight);
  const surface = (tokens.surfaces as Record<string, string>)[s.layout] ?? "paper";
  const bg = surface === "ink" ? ink : surface === "primary" ? primary : paper;
  const onDark = surface !== "paper";
  const T = surface === "ink" ? tokens.palette.onInk : tokens.palette.onPrimary;
  const fg = onDark ? paper : ink;
  const secondary = onDark ? mix(bg, paper, T.secondary) : muted;
  const chrome = onDark ? mix(bg, paper, T.chrome) : muted;
  const rulerPast = onDark ? mix(bg, paper, T.rulerPast) : mix(paper, ink, 0.3);
  const rulerFuture = onDark ? mix(bg, paper, T.rulerFuture) : rule;
  const rulerCurrent = surface === "ink" ? accent : onDark ? paper : primary;
  let primaryTextClasses = 0;

  // ---------- primitives ----------
  const rect = (x: number, y: number, w: number, h: number, color: string) => items.push({ kind: "rect", x, y, w, h, color });
  const role = (name: string, o: Partial<Role> = {}): Role => ({ ...ROLES[name], ...o });
  const tb = (text: string, r: Role, boxW: number, balance = false): TextBlock => block(r.upper ? upper(text) : text, boxW, r.size, r.lineHeight, r.font, r.bold, r.tracking, balance);
  /** Draw a measured block; returns its height. align "right" uses x as the right edge. */
  const draw = (blk: TextBlock, x: number, y: number, color: string, align: "left" | "right" = "left", boxW = 0, editField?: string) => {
    const blockId = `block-${items.length}`;
    if (blk.overflow) overflow = true;
    if (color === primary) primaryTextClasses++;
    blk.lines.forEach((line, i) => {
      if (!line) return;
      const lx = align === "right" ? x - blk.widths[i] : x;
      const t: Primitive = {
        kind: "text", text: line, x: lx, y: y + i * blk.lineHeight, w: boxW || blk.widths[i], size: blk.size,
        bold: blk.bold, color, font: blk.font, tracking: blk.tracking, lineHeight: blk.lineHeight / blk.size, editField, blockId,
      };
      items.push(t);
    });
    return blk.height;
  };
  const label = (text: string, x: number, y: number, color: string, boxW = 600, align: "left" | "right" = "left", editField?: string) => draw(tb(text, role("label"), boxW), x, y, color, align, 0, editField);

  // ---------- surface + chrome ----------
  rect(0, 0, W, H, bg);
  const wordmark = String(b.company || b.name);
  const wmBlock = tb(wordmark, role("label"), 400);
  draw(wmBlock, G.margin, Z.chromeTop, fg);
  if (s.eyebrow) label(s.eyebrow, G.margin + wmBlock.maxWidth + tokens.chrome.wordmarkGap, Z.chromeTop, chrome, 900, "left", "eyebrow");
  const paginationStart=items.length;
  const RU = tokens.chrome.ruler;
  if (total <= RU.maxSlides) {
    const totalW = total * RU.segment + (total - 1) * RU.gap;
    const x0 = W - G.margin - totalW, y0 = Z.chromeTop + Math.round((Z.chromeHeight - RU.height) / 2);
    for (let k = 1; k <= total; k++) rect(x0 + (k - 1) * (RU.segment + RU.gap), y0, RU.segment, RU.height, k === index + 1 ? rulerCurrent : k < index + 1 ? rulerPast : rulerFuture);
  }
  label(`${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`, W - G.margin, Z.footerTop, chrome, 200, "right");
  for(let i=paginationStart;i<items.length;i++){const item=items[i];if(item.kind==="text"||item.kind==="rect")item.binding="focus-v3-pagination";}
  const footerLeft = (text: string) => { if (text) label(text, G.margin, Z.footerTop, chrome, 1000, "left", "body"); };

  // ---------- title ----------
  const paragraphs = s.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const titleParts = s.title.split("\n").map((t) => t.trim()).filter(Boolean);
  let titleLines = 0, titleFill = 0, titleBottom = Z.titleTop;

  /** Display title (cover / statement / closing): first part fg, following parts in `accentColor`. */
  const displayBlocks = (r: Role) => titleParts.map((p) => tb(p, r, G.frame, true));
  const drawDisplay = (blocks: TextBlock[], y: number, accentColor: string) => {
    let yy = y;
    blocks.forEach((blk, i) => { yy += draw(blk, G.margin, yy, i === 0 ? fg : accentColor, "left", 0, "title"); });
    titleLines = blocks.reduce((n, b2) => n + b2.lines.length, 0);
    titleFill = Math.max(...blocks.map((b2) => b2.maxWidth)) / G.frame;
    if (titleLines > P.maxTitleLines.display) overflow = true;
    return yy;
  };
  /** h1 title: try 10 columns; widen to 12 when it needs more than two lines or fills the box too tightly. */
  const drawH1 = () => {
    const text = titleParts.join("\n");
    let boxW = fitAttempt ? G.frame : spanW(10), blk = tb(text, role("h1"), boxW, true);
    if (blk.lines.length > P.maxTitleLines.h1 || blk.maxWidth / boxW > P.maxTitleFill) { boxW = G.frame; blk = tb(text, role("h1"), boxW, true); }
    titleLines = blk.lines.length; titleFill = blk.maxWidth / boxW;
    if (titleLines > P.maxTitleLines.h1 || titleFill > P.maxTitleFill) overflow = true;
    titleBottom = Z.titleTop + draw(blk, G.margin, Z.titleTop, fg, "left", 0, "title");
  };

  // ---------- content helpers ----------
  let contentTop = Z.contentBottom, contentHeight = 0;
  const anchor = (h: number) => { contentHeight = h; contentTop = Z.contentBottom - h; if (contentTop - titleBottom < Z.minTitleGap) overflow = true; return contentTop; };

  /** Column block used by content / steps: rule, index, name (h2), text (small). */
  type Col = { idx: string; name: TextBlock; text: TextBlock };
  const columns = (parts: string[]) => {
    const n = Math.max(2, Math.min(4, parts.length));
    if (parts.length < 2 || parts.length > 4) overflow = true;
    const span = 12 / n, w = spanW(span);
    const cols: Col[] = parts.slice(0, 4).map((p, i) => {
      const [name, ...rest] = p.split("\n");
      return { idx: String(i + 1).padStart(2, "0"), name: tb(name, role("h2"), w), text: tb(rest.join(" "), role("small"), w) };
    });
    const hOf = (c: Col) => S.columnRule + S.colPadTop + 16 + S.colGap + c.name.height + (c.text.lines.length && c.text.lines[0] ? S.colGap + c.text.height : 0);
    const h = Math.max(...cols.map(hOf));
    const top = anchor(h);
    cols.forEach((c, i) => {
      const { x } = col(1 + i * span, span);
      rect(x, top, w, S.columnRule, fg);
      let y = top + S.columnRule + S.colPadTop;
      label(c.idx, x, y, muted, w); y += 16 + S.colGap;
      y += draw(c.name, x, y, fg, "left", 0, "body");
      if (c.text.lines[0]) { y += S.colGap; draw(c.text, x, y, muted, "left", 0, "body"); }
    });
  };

  switch (s.layout) {
    // ---------- bookends ----------
    case "cover": {
      const lead = tb(paragraphs[0] ?? "", role("body"), spanW(7));
      const leadTop = Z.contentBottom - lead.height;
      const blocks = displayBlocks(role("display"));
      const titleH = blocks.reduce((h, b2) => h + b2.height, 0);
      const titleTop = leadTop - Z.titleToLead - titleH;
      if (titleTop < Z.chromeTop + Z.chromeHeight + Z.minTitleGap) overflow = true;
      drawDisplay(blocks, titleTop, primary);
      draw(lead, G.margin, leadTop, muted, "left", 0, "body");
      footerLeft(paragraphs[1] ?? "");
      contentTop = titleTop; contentHeight = Z.contentBottom - titleTop; titleBottom = Z.chromeTop + Z.chromeHeight;
      break;
    }
    case "statement":
    case "closing": {
      const blocks = displayBlocks(role("displayS"));
      titleBottom = drawDisplay(blocks, Z.titleTop, s.layout === "statement" ? accent : paper);
      const body = tb(paragraphs.join("\n"), role("body"), spanW(7));
      draw(body, G.margin, anchor(body.height), secondary, "left", 0, "body");
      break;
    }
    // ---------- arguments ----------
    case "content": case "steps": {
      drawH1();
      if(variant==="lead") {
        const body=tb(paragraphs[0],role("body"),spanW(fitAttempt?10:7));
        draw(body,G.margin,anchor(body.height),fg,"left",0,"body");
      } else if(variant==="fact-rows") {
        const rows=paragraphs.map(p=>{const [name,...rest]=p.split("\n");return {name:tb(name,role("bigBold"),spanW(4)),text:tb(rest.join(" "),role("lead"),spanW(7))};});
        let heights=rows.map(r=>Math.max(112,Math.max(r.name.height,r.text.height)+48));
        let h=heights.reduce((a,b)=>a+b,0);
        if(Z.contentBottom-h-titleBottom<Z.minTitleGap){
          heights=rows.map(r=>Math.max(96,Math.max(r.name.height,r.text.height)+48));
          h=heights.reduce((a,b)=>a+b,0);
        }
        if(rows.some(r=>r.name.overflow||r.text.overflow)||Z.contentBottom-h-titleBottom<Z.minTitleGap){variant="cols";columns(paragraphs);}
        else {
          let y=anchor(h);
          rows.forEach((r,i)=>{rect(G.margin,y,G.frame,1,rule);draw(r.name,G.margin,y+24,fg,"left",0,"body");draw(r.text,col(6,7).x,y+24,muted,"left",0,"body");y+=heights[i];});
        }
      } else columns(paragraphs);
      break;
    }

    // ---------- comparison ----------
    case "split": {
      drawH1();
      if (variant === "before-after" && s.comparison) {
        const c = s.comparison, pad = S.cardPad;
        const hasPrompt = !!c.prompt;
        const wideCard = fitAttempt === 2;
        const card = hasPrompt ? (wideCard ? col(4, 9) : col(5, 8)) : col(1, 12);
        const innerW = card.w - 2 * pad.side;
        const before = tb(c.before.text, role("big"), innerW);
        const after = tb(c.after.text, role("bigBold"), wideCard ? innerW : Math.min(innerW, 760));
        const statusH = c.status ? 36 + 16 : 0;
        const cardH = pad.top + 16 + 14 + before.height + 28 + 1 + 28 + 16 + 14 + after.height + statusH + pad.bottom;
        const top = anchor(cardH);
        rect(card.x, top, card.w, cardH, tint);
        let y = top + pad.top;
        const x = card.x + pad.side;
        label(c.before.label || "Было", x, y, muted, innerW, "left", "comparison:before:label"); y += 16 + 14;
        draw(before, x, y, c.mode === "neutral" ? fg : muted, "left", 0, "comparison:before:text");
        if(c.mode !== "neutral") before.lines.forEach((_, i) => rect(x, y + i * before.lineHeight + before.lineHeight * 0.56, before.widths[i], 2, mix(tint, ink, 0.42))); // strike-through
        y += before.height + 28;
        rect(x, y, innerW, 1, cardRule); y += 1 + 28;
        label(c.after.label || "Предложено", x, y, primary, innerW, "left", "comparison:after:label"); y += 16 + 14;
        y += draw(after, x, y, fg, "left", 0, "comparison:after:text");
        if (c.status) label(c.status, x, y + 36, muted, innerW, "left", "comparison:status");
        if (hasPrompt && c.prompt) {
          const left = col(1, wideCard ? 3 : 4);
          rect(left.x, top, left.w, S.columnRule, fg);
          let ly = top + S.columnRule + S.colPadTop;
          label(c.prompt.label || "Замечание", left.x, ly, muted, left.w, "left", "comparison:prompt:label"); ly += 16 + S.colGap;
          draw(tb(c.prompt.text, role("lead"), Math.min(left.w, 400)), left.x, ly, fg, "left", 0, "comparison:prompt:text");
          if (paragraphs[0]) { const cap = tb(paragraphs[0], role("caption"), Math.min(left.w, 380)); draw(cap, left.x, top + cardH - cap.height, muted, "left", 0, "body"); }
        } else footerLeft(paragraphs[0] ?? "");
      } else {
        if (paragraphs.length !== 2) overflow = true;
        const w = spanW(6);
        const parts = paragraphs.slice(0, 2).map((p) => { const [l, ...r] = p.split("\n"); return { l, t: tb(r.join(" "), role("big"), w) }; });
        const h = S.columnRule + S.colPadTop + 16 + S.colGap + Math.max(...parts.map((p) => p.t.height));
        const top = anchor(h);
        parts.forEach((p, i) => {
          const { x } = col(1 + i * 6, 6);
          rect(x, top, w, S.columnRule, fg);
          label(p.l, x, top + S.columnRule + S.colPadTop, muted, w);
          draw(p.t, x, top + S.columnRule + S.colPadTop + 16 + S.colGap, fg, "left", 0, "body");
        });
      }
      break;
    }

    // ---------- table ----------
    case "table": {
      drawH1();
      if (!s.table) { overflow = true; break; }
      const dataStart=items.length;
      const t = s.table, n = t.columns.length;
      const prominent = variant === "numeric-rows";
      const roles = t.columnRoles ?? t.columns.map((_, j) => (j === 0 ? "key" : "text"));
      const idxW = 88, avail = G.frame - idxW - G.gutter - (n - 1) * G.gutter;
      const cellRole = (j: number) => (roles[j] === "key" ? role("key", prominent ? {size: 40} : {}) : role("body", prominent ? {size: 40} : {}));
      const headerRole = role("label", prominent ? {size: 18} : {});
      const natural = t.columns.map((_, j) => Math.max(measure(upper(t.columns[j]), headerRole.size, "mono", false, 0.12), ...t.rows.map((r) => measure(r[j], cellRole(j).size, "sans", cellRole(j).bold))));
      // Metadata (time, status codes) must not consume the free reading space.
      // Give it a compact measured width; descriptive columns share the rest.
      let widths = natural.map((w, j) => roles[j] === "key"
        ? Math.min(spanW(4), Math.max(spanW(3), w + 16))
        : roles[j] === "meta" ? Math.min(240, Math.max(120, w + 16)) : 0);
      const rest = Math.max(0, avail - widths.reduce((a, v) => a + v, 0));
      const flex = natural.map((w, j) => roles[j] === "key" || roles[j] === "meta" ? 0 : Math.max(240, w));
      const flexSum = flex.reduce((a, v) => a + v, 0);
      if (flexSum) widths = widths.map((w, j) => flex[j] ? Math.max(200, rest * flex[j] / flexSum) : w);
      else {
        const keys = roles.filter(r => r === "key").length;
        if (keys) widths = widths.map((w, j) => w + (roles[j] === "key" ? rest / keys : 0));
      }
      // Several key columns (or minimum flex widths) must share the same frame.
      const requestedWidth = widths.reduce((a, w) => a + w, 0);
      if (requestedWidth > avail) widths = widths.map(w => w * avail / requestedWidth);
      const xs: number[] = []; let cx = G.margin + idxW + G.gutter;
      widths.forEach((w) => { xs.push(cx); cx += w + G.gutter; });
      const headers = t.columns.map((c, j) => tb(c, headerRole, widths[j]));
      const rows = t.rows.map((r) => r.map((cell, j) => tb(cell, cellRole(j), widths[j])));
      const rowPad = prominent ? 28 : S.rowPad;
      const rowH = rows.map((r) => rowPad * 2 + Math.max(...r.map((c) => c.height)));
      const headerHeight = Math.max(16, ...headers.map(h => h.height));
      const headH = headerHeight + 14 + S.headerRule;
      const top = anchor(headH + rowH.reduce((a, v) => a + v, 0));
      label("№", G.margin, top, muted, idxW);
      headers.forEach((h, j) => draw(h, xs[j], top, muted, "left", 0, `table:column:${j}`));
      rect(G.margin, top + headerHeight + 14, G.frame, S.headerRule, fg);
      let y = top + headH;
      rows.forEach((r, i) => {
        const base = y + rowPad;
        label(String(i + 1).padStart(2, "0"), G.margin, base + 6, muted, idxW);
        r.forEach((c, j) => {
          const right = roles[j] === "number";
          draw(c, right ? xs[j] + widths[j] : xs[j], base, roles[j] === "meta" ? muted : fg, right ? "right" : "left", 0, `table:${i}:${j}`);
        });
        y += rowH[i];
        if (i < rows.length - 1) rect(G.margin, y, G.frame, 1, rule);
      });
      dataRange={start:dataStart,end:items.length};
      footerLeft(paragraphs[0] ?? "");
      break;
    }

    // ---------- metrics ----------
    case "metrics": {
      drawH1();
      if (!s.metrics.length) { overflow = true; break; }
      const fmt = (v: number) => v.toLocaleString("ru-RU");
      if (variant === "facts") {
        const valueW = spanW(8);
        const vals = s.metrics.slice(0, 4).map((m) => tb(`${fmt(m.value)} ${m.unit}`.trim(), role("bigBold"), valueW));
        const rowH = vals.map((v) => S.factPad * 2 + Math.max(16, v.height));
        const top = anchor(rowH.reduce((a, v) => a + v, 0) + 1);
        let y = top;
        s.metrics.slice(0, 4).forEach((m, i) => {
          rect(G.margin, y, G.frame, 1, i === 0 ? fg : rule);
          label(m.label, G.margin, y + 1 + S.factPad + Math.round((vals[i].lineHeight - 16) / 2), muted, spanW(4), "left", `metric:${m.id}:label`);
          draw(vals[i], col(5, 8).x, y + 1 + S.factPad, fg, "left", 0, `metric:${m.id}:value`);
          y += rowH[i];
        });
      } else {
        const n = Math.min(4, s.metrics.length), span = 12 / n, w = spanW(span);
        const cells = s.metrics.slice(0, 4).map((m) => ({ num: tb(fmt(m.value), role("numeral"), w), unit: tb(m.unit, role("big"), w), lab: tb(m.label, role("small"), w) }));
        const h = S.columnRule + S.colPadTop + Math.max(...cells.map((c) => c.num.height + 8 + c.unit.height + 16 + c.lab.height));
        const top = anchor(h);
        cells.forEach((c, i) => {
          const { x } = col(1 + i * span, span);
          rect(x, top, w, S.columnRule, fg);
          let y = top + S.columnRule + S.colPadTop;
          y += draw(c.num, x, y, fg, "left", 0, `metric:${s.metrics[i].id}:value`) + 8;
          y += draw(c.unit, x, y, muted, "left", 0, `metric:${s.metrics[i].id}:unit`) + 16;
          draw(c.lab, x, y, muted, "left", 0, `metric:${s.metrics[i].id}:label`);
        });
      }
      footerLeft(paragraphs[0] ?? "");
      break;
    }

    // ---------- chart ----------
    case "chart": {
      drawH1();
      if (!s.chart.length) { overflow = true; break; }
      const dataStart=items.length;
      const lo = Math.min(0, ...s.chart.map((v) => v.value)), hi = Math.max(0, ...s.chart.map((v) => v.value)), span = hi - lo || 1;
      const rows = s.chart.slice(0, 8);
      const prominent = variant === "bars-large";
      const valC = col(10, 3);
      const values = rows.map(v => tb(`${v.value.toLocaleString("ru-RU")} ${s.chartUnit}`.trim(), role("monoValue", prominent ? {size: 24} : {}), valC.w));
      const layout = (span: number) => {
        const labelC = col(1, span), barC = col(span + 1, 9 - span);
        const labels = rows.map(v => tb(v.label, role("body", prominent ? {size: 36} : {}), labelC.w));
        const heights = labels.map((l, i) => Math.max(prominent ? 96 : S.chartRow, l.height + 16, values[i].height + 16));
        return {labelC, barC, labels, heights, height: 1 + heights.reduce((a, h) => a + h, 0)};
      };
      let chosen = layout(3);
      // Use a title-independent budget so freezing the chart into a data object
      // chooses the same recipe even when its synthetic slide has no heading.
      const available = Z.contentBottom - Z.titleTop - P.maxTitleLines.h1 * ROLES.h1.size * ROLES.h1.lineHeight - Z.minTitleGap;
      // Widen labels before rejecting a dense chart; the bar and number columns stay separate.
      if (chosen.height > available || chosen.labels.some(l => l.overflow)) {
        for (const span of [4, 5]) {
          const candidate = layout(span);
          if (candidate.height < chosen.height || chosen.labels.some(l => l.overflow) && !candidate.labels.some(l => l.overflow)) {
            chosen = candidate; variant = "bars-wide-labels";
          }
          if (chosen.height <= available && !chosen.labels.some(l => l.overflow)) break;
        }
      }
      const {labelC, barC} = chosen;
      const top = anchor(chosen.height);
      rect(G.margin, top, G.frame, 1, fg);
      const zero = barC.x + ((0 - lo) / span) * barC.w;
      rect(zero, top + 1, 1, chosen.height - 1, fg);
      let y = top + 1;
      rows.forEach((v, i) => {
        const rowH = chosen.heights[i];
        draw(chosen.labels[i], labelC.x, y + (rowH - chosen.labels[i].height) / 2, fg, "left", 0, `chart:${i}:label`);
        const end = barC.x + ((v.value - lo) / span) * barC.w;
        const barHeight = prominent ? 40 : S.barHeight;
        if (v.value) rect(Math.min(zero, end), y + (rowH - barHeight) / 2, Math.abs(end - zero), barHeight, v.value > 0 ? primary : muted);
        draw(values[i], valC.x + valC.w, y + (rowH - values[i].height) / 2, fg, "right", 0, `chart:${i}:value`);
        y += rowH;
        if (i < rows.length - 1) rect(G.margin, y, G.frame, 1, rule);
      });
      dataRange={start:dataStart,end:items.length};
      footerLeft(paragraphs[0] ?? "");
      break;
    }

    // ---------- image ----------
    case "image": {
      drawH1();
      const img = col(5, 8), imgH = Math.round((img.w * 9) / 16);
      const top = anchor(imgH);
      if (s.assetId) items.push({ kind: "image", assetId: s.assetId, x: img.x, y: top, w: img.w, h: imgH });
      else { overflow = true; rect(img.x, top, img.w, imgH, tint); }
      const text = tb(paragraphs.join("\n"), role("small"), col(1, 4).w);
      draw(text, G.margin, Z.contentBottom - text.height, muted, "left", 0, "body");
      break;
    }
  }

  // Retry only an overflowing scene, preserving accepted geometry for content that already fits.
  // First widen the title, then the comparison card. Fonts, text and tracking stay unchanged.
  if (overflow && fitAttempt < (s.comparison ? 2 : 1)) return focusV3Scene(slide, b, index, total, fitAttempt + 1, prominentData);

  // ---------- meta for design-review ----------
  const frameArea = G.frame * (Z.footerTop - Z.titleTop);
  const inkArea = items.reduce((a, it) => {
    if (it.kind === "text") return a + it.w * it.size * 1.1;
    if (it.kind === "rect" && it.h > 4 && !(it.w === W && it.h === H)) return a + it.w * it.h * 0.35; // tint card, bars
    if (it.kind === "image") return a + it.w * it.h * 0.5;
    return a;
  }, 0);
  if (contentHeight < P.minContentHeight && s.layout !== "cover") overflow = overflow || false; // reported via meta, not an error
  const meta: SceneMeta = {
    variant: fitAttempt ? `${variant}-wide` : variant, titleLines, titleFill: Math.round(titleFill * 100) / 100, contentHeight: Math.round(contentHeight),
    gap: Math.round(contentTop - titleBottom), occupancy: Math.round((inkArea / frameArea) * 1000) / 1000, primaryTextClasses,
  };
  return { items, overflow, meta, dataRange };
}
