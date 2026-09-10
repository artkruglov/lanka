import type { Brand, Slide } from "./model";
import type { Primitive, Scene } from "./scene";
import { wrap } from "./scene-text";

/** Versioned composition system. Content and brand are inputs, never mutated. */
export function atelierScene(s: Slide, b: Brand, index: number, total: number): Scene {
  const items: Primitive[] = [];
  let dataRange:Scene["dataRange"];
  let overflow = false;
  const rect = (x: number, y: number, w: number, h: number, color: string) =>
    items.push({ kind: "rect", x, y, w, h, color });
  const text = (value: string, x: number, y: number, w: number, h: number,
    size: number, color = b.ink, bold = false, min = size * 0.8) => {
    let chosen = size;
    let lines = wrap(value, w, chosen, bold);
    while (lines.length * chosen * 1.17 > h && chosen > min) {
      chosen = Math.max(min, chosen - 1);
      lines = wrap(value, w, chosen, bold);
    }
    if (lines.length * chosen * 1.17 > h) overflow = true;
    lines.forEach((line, i) => {
      if (line) items.push({ kind: "text", text: line, x, y: y + i * chosen * 1.17,
        w, size: chosen, color, bold });
    });
  };
  const dark = s.layout === "cover" || s.layout === "closing";
  const fg = dark ? b.paper : b.ink;
  rect(0, 0, 1600, 900, dark ? b.ink : b.paper);
  text(b.company || b.name, 80, 47, 720, 40, 22, fg, true);
  rect(80, 804, 1440, 1, dark ? b.paper : b.ink);
  text(`${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`,
    1380, 829, 140, 32, 18, fg);
  if (s.sourceIds.length) text(`Источники: ${s.sourceIds.map((_, i) => `[${i + 1}]`).join(" ")}`,
    80, 829, 1130, 32, 16, fg);
  const eyebrow = (y = 149) => text(s.eyebrow, 80, y, 1340, 55, 21, dark ? b.paper : b.primary, true);
  const heading = () => {
    eyebrow();
    text(s.title, 80, 211, 1430, 173, 65, b.ink, true, 50);
  };
  const paragraphs = s.body.split(/\n\s*\n/).filter(p => p.trim());
  const argument = (value: string, x: number, y: number, w: number, h: number, size = 31) => {
    const [lead, ...rest] = value.split("\n");
    if (rest.length && lead.trim()) {
      text(lead, x, y, w, h * 0.38, size, b.ink, true, 26);
      text(rest.join("\n"), x, y + h * 0.42, w, h * 0.58, size - 3, b.ink, false, 24);
    } else text(value, x, y, w, h, size, b.ink, false, 24);
  };
  switch (s.layout) {
    case "cover":
      eyebrow(163);
      rect(80, 247, 72, 7, b.accent);
      text(s.title, 80, 297, 1420, 305, 107, fg, true, 76);
      text(s.body, 80, 655, 1210, 116, 30, fg, false, 26);
      break;
    case "closing":
      eyebrow(168);
      text(s.title, 80, 286, 1400, 306, 105, fg, true, 74);
      rect(80, 637, 72, 7, b.accent);
      text(s.body, 205, 630, 1230, 142, 30, fg, false, 26);
      break;
    case "statement":
      eyebrow();
      text(s.title, 80, 262, 1390, 329, 98, b.ink, true, 72);
      rect(80, 651, 72, 6, b.primary);
      text(s.body, 216, 636, 1210, 140, 32, b.ink, false, 26);
      break;
    case "content": {
      eyebrow();
      text(s.title, 80, 240, 585, 500, 65, b.ink, true, 48);
      rect(722, 244, 1, 494, b.ink);
      if (paragraphs.length > 0 && paragraphs.length <= 3) {
        const h = 492 / paragraphs.length;
        paragraphs.forEach((p, i) => {
          text(String(i + 1).padStart(2, "0"), 777, 249 + i * h, 54, 40, 19, b.primary, true);
          argument(p, 864, 244 + i * h, 636, h - 36);
        });
      } else text(s.body, 798, 244, 710, 500, 31, b.ink, false, 24);
      break;
    }
    case "split": {
      heading();
      const mid = Math.ceil(paragraphs.length / 2);
      const groups = [paragraphs.slice(0, mid), paragraphs.slice(mid)];
      groups.forEach((parts, i) => {
        const x = 80 + i * 756;
        rect(x, 420, 672, 3, i ? b.ink : b.primary);
        text(i ? "02" : "01", x, 452, 110, 66, 40, b.primary, true);
        argument(parts.join("\n\n"), x, 553, 672, 217, 34);
      });
      break;
    }
    case "metrics": {
      heading();
      const col = 1440 / Math.max(1, s.metrics.length);
      s.metrics.forEach((m, i) => {
        const x = 80 + i * col;
        if (i) rect(x - 24, 446, 1, 259, b.ink);
        text(m.value.toLocaleString("ru-RU"), x, 434, col - 48, 141,
          s.metrics.length === 1 ? 134 : 112, b.primary, true, 70);
        text(m.unit, x, 590, col - 44, 44, 25, b.ink);
        text(m.label, x, 653, col - 44, 84, 29, b.ink, false, 24);
      });
      text(s.body, 80, 762, 1350, 29, 18, b.ink, false, 18);
      break;
    }
    case "steps": {
      heading();
      if (paragraphs.length < 2 || paragraphs.length > 4) overflow = true;
      const col = 1440 / Math.max(2, Math.min(4, paragraphs.length));
      paragraphs.slice(0, 4).forEach((step, i) => {
        const x = 80 + i * col;
        rect(x, 442, col - 35, 3, b.primary);
        text(String(i + 1).padStart(2, "0"), x, 468, col - 40, 92, 67, b.primary, true);
        argument(step, x, 607, col - 42, 162, 29);
      });
      break;
    }
    case "chart": {
      eyebrow();
      text(s.title, 80, 211, 1430, 123, 61, b.ink, true, 48);
      const dataStart=items.length;
      const min = Math.min(0, ...s.chart.map(p => p.value));
      const max = Math.max(0, ...s.chart.map(p => p.value));
      const range = max - min || 1;
      const zero = 434 + (-min / range) * 797;
      const row = Math.min(104, 406 / Math.max(1, s.chart.length));
      s.chart.forEach((p, i) => {
        const y = 365 + i * row;
        const point = 434 + ((p.value - min) / range) * 797;
        text(p.label, 80, y + 3, 324, row - 9, 27, b.ink, false, 21);
        rect(zero, y, 1, row - 16, b.ink);
        if (p.value) rect(Math.min(zero, point), y + 3, Math.abs(point - zero), row - 21, b.primary);
        text(p.value.toLocaleString("ru-RU") + " " + s.chartUnit, 1285, y + 3, 235, row - 9, 27, b.ink, true, 21);
      });
      dataRange={start:dataStart,end:items.length};
      text(s.body, 80, 765, 1350, 27, 18, b.ink, false, 18);
      break;
    }
    case "image":
      eyebrow();
      if (s.assetId) items.push({kind: "image", x: 690, y: 242, w: 830, h: 528, assetId: s.assetId});
      else {
        rect(690, 242, 830, 528, b.ink);
        text("Добавьте изображение", 754, 463, 690, 108, 43, b.paper, true);
      }
      text(s.title, 80, 242, 525, 295, 57, b.ink, true, 44);
      text(s.body, 80, 568, 525, 204, 29, b.ink, false, 24);
      break;
  }
  return { items, overflow, dataRange };
}
