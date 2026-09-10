import { CANVAS, box, inset, canvasToInches } from "@seekskyworld/creatppt";
import { wrap } from "./scene-text";
export { measure } from "./scene-text";
import { atelierScene } from "./atelier";
import { folioScene } from "./folio";
import { focusScene } from "./focus";
import { focusV2Scene } from "./focus-v2";
import { focusV3Scene, type SceneMeta } from "./focus-v3";
import type { Design } from "./design";
import type { Brand, Slide } from "./model";
import { attachDataObject } from "./data-object";
import type { DataObject } from "./data-object";
import { canvasScene, canvasFromScene } from "./canvas";
import type { ImageFrame } from './image-frame';
export { canvasToInches };
export const W = CANVAS.width,
  H = CANVAS.height;
export type Primitive =
  | { kind: "rect"; x: number; y: number; w: number; h: number; color: string; binding?: "focus-v3-pagination" }
  | {
      kind: "text";
      x: number;
      y: number;
      w: number;
      size: number;
      bold: boolean;
      color: string;
      text: string;
      binding?: "focus-v3-pagination";
      editField?: string;
      /** Lines emitted by one measured text block; only used when unlocking objects. */
      blockId?: string;
      /** Plex roles; absent preserves legacy font and baseline behavior. */
      font?: "sans" | "mono";
      tracking?: number;
      /** Line height in em, carried from the measured typography role. */
      lineHeight?: number;
    }
  | {
      kind: "image";
      x: number;
      y: number;
      w: number;
      h: number;
      assetId: string;
      frame?: ImageFrame;
    };
export type Scene = { items: Primitive[]; overflow: boolean; meta?: SceneMeta; dataRange?:{start:number;end:number}; dataObjects?:{start:number;end:number;element:DataObject}[] };
export function scene(slide: Slide, brand: Brand, index = 0, total = 1, design: Design = "classic-v1"): Scene {
  if (slide.canvas) return canvasScene(slideCanvasObjects(slide,brand,index,total,design));
  return attachDataObject(templateScene(slide,brand,index,total,design),slide,brand,design);
}
/** Only explicitly bound template chrome follows deck order; legacy artwork is preserved. */
export function slideCanvasObjects(slide:Slide,brand:Brand,index:number,total:number,design:Design="classic-v1") {
  if(!slide.canvas)return canvasFromScene(scene(slide,brand,index,total,design));
  const bound=(e:typeof slide.canvas[number])=>(e.kind==='text'||e.kind==='rect')&&e.binding==='focus-v3-pagination';
  if(design!=='focus-v3'||!slide.canvas.some(bound))return slide.canvas;
  const fresh=canvasFromScene(templateScene(slide,brand,index,total,design),true).filter(bound);
  const ids=new Set(slide.canvas.filter(e=>!bound(e)).map(e=>e.id));
  const anchor=slide.canvas.find(e=>e.kind==="text"&&bound(e));
  if(anchor)ids.add(anchor.id);
  fresh.forEach((e,i)=>{if(e.kind==="text"&&anchor){e.id=anchor.id;e.locked=true;return;}let id=`pagination-${i}`;while(ids.has(id))id+='-';ids.add(id);e.id=id;e.locked=true;});
  const result:typeof slide.canvas=[];let inserted=false;
  for(const e of slide.canvas){if(bound(e)){if(!inserted){result.push(...fresh);inserted=true;}}else result.push(e);}
  return result;
}
function templateScene(slide:Slide,brand:Brand,index:number,total:number,design:Design):Scene {
  if (design === "focus-v3") return focusV3Scene(slide, brand, index, total);
  if (design === "focus-v2") return focusV2Scene(slide, brand, index, total);
  if (design === "focus-v1") return focusScene(slide, brand, index, total);
  if (design === "folio-v1" || design === "boardroom-v1" || slide.layout === "table") return folioScene(slide, brand, index, total, design === "boardroom-v1");
  if (design === "atelier-v1") return atelierScene(slide, brand, index, total);
  const items: Primitive[] = [];
  let overflow = false;
  let dataRange:Scene["dataRange"];
  const rect = (x: number, y: number, w: number, h: number, color: string) =>
    items.push({ kind: "rect", x, y, w, h, color });
  const text = (
    value: string,
    x: number,
    y: number,
    w: number,
    h: number,
    size: number,
    color = brand.ink,
    bold = false,
  ) => {
    let chosen = size,
      lines = wrap(value, w, chosen, bold);
    while (lines.length * chosen * 1.32 > h && chosen > 18) {
      chosen -= 1;
      lines = wrap(value, w, chosen, bold);
    }
    if (lines.length * chosen * 1.32 > h) overflow = true;
    lines.forEach((line, i) => {
      if (line)
        items.push({
          kind: "text",
          x,
          y: y + i * chosen * 1.32,
          w,
          size: chosen,
          bold,
          color,
          text: line,
        });
    });
  };
  const frame = inset(box(0, 0, W, H), {
    left: 88,
    right: 88,
    top: 58,
    bottom: 60,
  });
  const cover = slide.layout === "cover" || slide.layout === "closing";
  rect(0, 0, W, H, cover ? brand.primary : brand.paper);
  const ink = cover ? "#FFFFFF" : brand.ink;
  text(brand.company || brand.name, frame.x, 50, 700, 45, 22, ink, true);
  text(
    `${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`,
    1370,
    820,
    142,
    34,
    18,
    ink,
  );
  if (cover) {
    rect(1210, 180, 302, 10, brand.accent);
    rect(1320, 214, 192, 10, brand.accent);
    text(slide.eyebrow, 88, 204, 1070, 50, 22, "#FFFFFF", true);
    text(slide.title, 88, 285, 1190, 310, 78, "#FFFFFF", true);
    text(slide.body, 88, 633, 1040, 155, 29, "#FFFFFF");
  } else {
    rect(88, 112, 55, 5, brand.primary);
    text(slide.eyebrow, 166, 105, 1200, 40, 18, brand.primary, true);
    if (slide.layout === "statement") {
      rect(88, 205, 10, 500, brand.primary);
      text(slide.title, 135, 214, 800, 500, 66, brand.ink, true);
      rect(1030, 237, 482, 5, brand.accent);
      text(slide.body, 1030, 285, 482, 428, 30);
    } else text(slide.title, 88, 172, 1424, 160, 53, brand.ink, true);
    if (slide.layout === "steps") {
      const steps = slide.body.split(/\n\s*\n/).filter((s) => s.trim());
      if (steps.length < 2 || steps.length > 4) overflow = true;
      const col = 1424 / Math.max(2, Math.min(4, steps.length));
      steps.slice(0, 4).forEach((step, i) => {
        const x = 88 + i * col;
        rect(x, 388, col - 30, 5, brand.accent);
        text(
          String(i + 1).padStart(2, "0"),
          x,
          416,
          col - 35,
          67,
          42,
          brand.primary,
          true,
        );
        text(step, x, 519, col - 40, 254, 28);
      });
    }
    if (slide.layout === "content") {
      text(slide.body, 88, 374, 1380, 389, 32);
    }
    if (slide.layout === "split") {
      const parts = slide.body.split(/\n\s*\n/),
        mid = Math.ceil(parts.length / 2);
      rect(797, 365, 2, 382, brand.accent);
      text(parts.slice(0, mid).join("\n\n"), 88, 371, 642, 396, 30);
      text(parts.slice(mid).join("\n\n"), 864, 371, 646, 396, 30);
    }
    if (slide.layout === "metrics") {
      const count = Math.max(1, slide.metrics.length),
        col = 1424 / count;
      slide.metrics.forEach((m, i) => {
        const x = 88 + i * col;
        rect(x, 385, col - 26, 6, brand.primary);
        text(
          m.value.toLocaleString("ru-RU"),
          x,
          438,
          col - 40,
          108,
          72,
          brand.primary,
          true,
        );
        text(m.unit, x, 552, col - 40, 50, 22, brand.primary);
        text(m.label, x, 622, col - 42, 106, 27);
      });
      text(slide.body, 88, 762, 1300, 42, 18);
    }
    if (slide.layout === "chart") {
      const dataStart=items.length;
      const values = slide.chart.map((p) => p.value),
        min = Math.min(0, ...values),
        max = Math.max(0, ...values),
        range = max - min || 1,
        plotTop = 405,
        plotH = 275,
        zero = plotTop + (max / range) * plotH,
        col = 1260 / Math.max(1, values.length);
      rect(110, zero, 1310, 2, "#AFB5C5");
      slide.chart.forEach((p, i) => {
        const x = 136 + i * col,
          point = plotTop + ((max - p.value) / range) * plotH;
        rect(
          x,
          Math.min(zero, point),
          Math.max(16, col - 40),
          Math.max(1, Math.abs(zero - point)),
          i % 2 ? brand.accent : brand.primary,
        );
        text(
          p.value.toLocaleString("ru-RU") + " " + slide.chartUnit,
          x,
          Math.max(365, Math.min(point, zero) - 39),
          col - 30,
          36,
          20,
          brand.ink,
          true,
        );
        text(p.label, x, 703, col - 27, 64, 20);
      });
      dataRange={start:dataStart,end:items.length};
      text(slide.body, 88, 779, 1330, 39, 18);
    }
    if (slide.layout === "image") {
      if (slide.assetId)
        items.push({
          kind: "image",
          x: 88,
          y: 361,
          w: 883,
          h: 418,
          assetId: slide.assetId,
        });
      else {
        rect(88, 361, 883, 418, "#EEF0F6");
        text("Выберите изображение", 210, 540, 650, 70, 28, "#676C81");
      }
      text(slide.body, 1031, 366, 481, 405, 28);
    }
  }
  if (slide.sourceIds.length)
    text(
      `Источники: ${slide.sourceIds.map((_, i) => `[${i + 1}]`).join(" ")}`,
      88,
      832,
      1070,
      32,
      16,
      cover ? "#FFFFFF" : "#676C81",
    );
  return { items, overflow, dataRange };
}
