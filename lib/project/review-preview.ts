import type { CanvasElement, Slide } from "../domain/model";
import { canonicalJson } from "../domain/canonical-json";
import { isSlideBackground } from "../domain/canvas-lock";
import { mergeObjects, objectChanges, remainingSlide, type ProposalChange } from "../domain/object-review";

export type ReviewObject = {
  id: string; number: number; label: string; reasons: string[];
  before?: CanvasElement; after?: CanvasElement;
  status: "pending" | "accepted" | "rejected";
  independent: boolean; conflict: string;
};
const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const appearance = (e: CanvasElement) => {
  const { id, x, y, w, h, ...rest } = e;
  if (rest.kind === "text") { const { text, ...style } = rest; return style; }
  if (rest.kind === "chart" || rest.kind === "table") { const { data, ...style } = rest; return style; }
  return rest;
};

/** Stable numbers refer to the original proposal, even after individual decisions disappear from the pending list. */
export function reviewObjects(change: ProposalChange, current?: Slide): ReviewObject[] {
  const a = change.before.canvas, b = change.after.canvas;
  if (!a || !b) return [];
  const independent = objectChanges(change);
  const oldOrder = a.filter(e => b.some(v => v.id === e.id)).map(e => e.id);
  const newOrder = b.filter(e => a.some(v => v.id === e.id)).map(e => e.id);
  const items: ReviewObject[] = [];
  for (const id of new Set([...a, ...b].map(e => e.id))) {
    const before = a.find(e => e.id === id), after = b.find(e => e.id === id);
    const reordered = !!before && !!after && oldOrder.indexOf(id) !== newOrder.indexOf(id);
    if (same(before, after) && !reordered) continue;
    const object = after ?? before!;
    const label = object.kind === "text" ? object.text || "Пустой текст" : object.kind === "image" ? "Изображение"
      : object.kind === "chart" ? "Диаграмма" : object.kind === "table" ? "Таблица"
      : isSlideBackground(object) && a[0]?.id === id ? "Фон слайда" : "Фигура";
    const reasons: string[] = [];
    if (!before) reasons.push("Добавление");
    else if (!after) reasons.push("Удаление");
    else {
      if (before.x !== after.x || before.y !== after.y) reasons.push("Положение");
      if (before.w !== after.w || before.h !== after.h) reasons.push("Размер");
      if (before.kind === "text" && after.kind === "text" && before.text !== after.text) reasons.push("Текст");
      if ((before.kind === "chart" || before.kind === "table") && (after.kind === "chart" || after.kind === "table") && !same(before.data, after.data)) reasons.push("Данные");
      if (!same(appearance(before), appearance(after))) reasons.push("Оформление");
      if (reordered) reasons.push("Порядок слоёв");
    }
    const status = change.objectDecisions?.find(d => d.elementId === id)?.status ?? "pending";
    let conflict = "";
    if (independent?.includes(id) && status === "pending") {
      try { mergeObjects(current, change, [id]); } catch (e) { conflict = (e as Error).message; }
    }
    items.push({ id, number: items.length + 1, label, reasons, before, after, status, independent: !!independent?.includes(id), conflict });
  }
  return items;
}

/** A conflicted original is never presented as the result of applying changes to the current slide. */
export function reviewPreview(change: ProposalChange, current?: Slide) {
  try {
    return { before: current!, after: remainingSlide(current, change), conflicted: false };
  } catch {
    return { before: change.before, after: change.after, conflicted: true };
  }
}
