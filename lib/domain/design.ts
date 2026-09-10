import { z } from "zod";
export const designSchema = z.enum(["classic-v1", "atelier-v1", "folio-v1", "boardroom-v1", "focus-v1", "focus-v2", "focus-v3"]);
export type Design = z.infer<typeof designSchema>;
export const defaultDesign: Design = "focus-v2";
export const designNames: Record<Design, string> = {
  "focus-v3": "Focus 3 — редакционный",
  "focus-v2": "Focus 2 — ясный акцент",
  "focus-v1": "Focus 1 — открытые композиции",
  "folio-v1": "Folio — продукт и продажи",
  "boardroom-v1": "Boardroom — решения и отчёты",
  "atelier-v1": "Atelier — выразительная типографика",
  "classic-v1": "Classic — спокойная сетка",
};
export const designOptions = ["focus-v3", "focus-v2", "focus-v1", "folio-v1", "boardroom-v1", "atelier-v1", "classic-v1"] as const;
