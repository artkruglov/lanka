import type { Primitive } from "./scene";
import { baseline } from "./scene-text-v3";

/** Shared by the editor and every exporter. Legacy scenes retain their old baseline. */
export function textStyle(p: Extract<Primitive, { kind: "text" }>) {
  const plex = p.font !== undefined;
  return {
    family: plex ? p.font === "mono" ? "IBM Plex Mono" : "IBM Plex Sans" : "DejaVu Sans",
    weight: plex ? p.font === "mono" ? 500 : p.bold ? 600 : 400 : p.bold ? 700 : 400,
    spacing: (p.tracking ?? 0) * p.size,
    baseline: plex ? baseline(p.size, p.lineHeight ?? 1.38, p.font) : p.size,
  };
}

export function pdfFontFiles(design?: string) {
  return design === "focus-v3"
    ? ["IBMPlexSans-Regular.ttf", "IBMPlexSans-SemiBold.ttf", "IBMPlexMono-Medium.ttf"] as const
    : ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"] as const;
}
