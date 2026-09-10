import type { Brand, DeckDoc, Slide } from "./domain/model";
import { scene, W, H } from "./domain/scene";
import { textStyle } from "./domain/scene-typography";
import {imagePlacement} from './domain/image-frame';

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** SVG export from the same measured primitives as SlideCanvas. fontCss can embed local TTFs. */
export function slideSvg(slide: Slide, brand: Brand, index: number, total: number, design?: DeckDoc["design"], fontCss = "", imageHref: (id: string) => string = id => `/api/assets?id=${encodeURIComponent(id)}`) {
  const data = scene(slide, brand, index, total, design);
  if (data.overflow) throw new Error(`Текст не помещается на слайде ${index + 1}.`);
  const items = data.items.map(p => {
    if (p.kind === "rect") return `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="${p.color}"/>`;
    if (p.kind === "image") {
      if(p.frame){
        const {viewport:v,source:s}=imagePlacement(p,p.frame);
        return `<svg x="${v.x}" y="${v.y}" width="${v.w}" height="${v.h}" viewBox="${s.x} ${s.y} ${s.w} ${s.h}" preserveAspectRatio="none" overflow="hidden"><image href="${esc(imageHref(p.assetId))}" width="${p.frame.sourceWidth}" height="${p.frame.sourceHeight}"/></svg>`;
      }
      return `<image href="${esc(imageHref(p.assetId))}" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" preserveAspectRatio="xMidYMid meet"/>`;
    }
    const style = textStyle(p);
    return `<text x="${p.x}" y="${p.y + style.baseline}" font-family="${style.family}" font-size="${p.size}" font-weight="${style.weight}" fill="${p.color}" letter-spacing="${style.spacing}" xml:space="preserve"${p.font ? ' style="font-feature-settings:&quot;tnum&quot;,&quot;kern&quot;"' : ""}>${esc(p.text)}</text>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><title>${esc(slide.title)}</title>${fontCss ? `<style>${fontCss}</style>` : ""}${items}</svg>`;
}
