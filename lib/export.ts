import {addNativeData} from "./data-export";
import {dataSourceIds} from "./domain/data-object";
import type { DeckDoc, Source } from "./domain/model";
import { scene, W, H, canvasToInches } from "./domain/scene";
import { textStyle, pdfFontFiles } from "./domain/scene-typography";
import plexMetrics from "./domain/font-metrics-plex.json";
import {imagePlacement,assertImageDimensions} from './domain/image-frame';
import {assertUprightImage} from './domain/image-orientation';
import {download} from './project/download';
export {download} from './project/download';
export function downloadJson(value: unknown, name: string) {
  download(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
    name,
  );
}
export function safeName(name: string) {
  return name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 90) || "presentation";
}
async function asset(id: string) {
  const res = await fetch(`/api/assets?id=${encodeURIComponent(id)}`);
  if (!res.ok)
    throw new Error("Не удалось загрузить изображение для экспорта.");
  return {
    bytes: await res.arrayBuffer(),
    type: res.headers.get("content-type") || "",
  };
}
function dataUri(bytes: ArrayBuffer, type: string) {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return `data:${type};base64,${btoa(binary)}`;
}
export async function buildPptx(
  doc: DeckDoc,
  sources: Source[] = [],
  loadAsset: typeof asset = asset,
) {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = doc.title;
  pptx.author = "Lanka Studio";
  pptx.subject = `Brand ${doc.brand.id}@${doc.brand.version}`;
  pptx.company = doc.brand.company;
  const plex = doc.design === "focus-v3";
  pptx.theme = { headFontFace: plex ? "IBM Plex Sans" : "DejaVu Sans", bodyFontFace: plex ? "IBM Plex Sans" : "DejaVu Sans" };
  const images = new Map<string, string>();
  const imageSizes = new Map<string,{width:number;height:number}>();
  for (const [i, s] of doc.slides.entries()) {
    const page = pptx.addSlide();
    const data = scene(s, doc.brand, i, doc.slides.length, doc.design);
    if (data.overflow)
      throw new Error(
        `Текст не помещается на слайде ${i + 1}. Сократите его перед экспортом.`,
      );
    for (const [primitiveIndex,p] of data.items.entries()) {
      const native=data.dataObjects?.find(r=>primitiveIndex>=r.start&&primitiveIndex<r.end);
      if(native){if(primitiveIndex===native.start)addNativeData(page,pptx,native.element);continue;}
      const x = canvasToInches(p.x),
        y = canvasToInches(p.y);
      if (p.kind === "rect")
        page.addShape(pptx.ShapeType.rect, {
          x,
          y,
          w: canvasToInches(p.w),
          h: canvasToInches(p.h),
          line: { color: p.color.slice(1), transparency: 100 },
          fill: { color: p.color.slice(1) },
        });
      else if (p.kind === "text") {
        const style = textStyle(p);
        page.addText(p.text, {
          x,
          y: p.font ? canvasToInches(p.y + style.baseline - plexMetrics.vertical[p.font].ascent * p.size) : y,
          w: canvasToInches(p.w + (p.font ? Math.max(0, style.spacing) + 2 : 0)),
          h: canvasToInches(p.size * 1.35),
          fontFace: style.family,
          fontSize: p.font ? p.size * 0.6 : canvasToInches(p.size) * 72,
          charSpacing: p.font ? style.spacing * 0.6 : undefined,
          wrap: p.font ? false : undefined,
          bold: p.bold,
          color: p.color.slice(1),
          margin: 0,
          breakLine: false,
          paraSpaceAfter: 0,
          valign: "top",
        });
      } else {
        let data = images.get(p.assetId);
        if (!data) {
          const a = await loadAsset(p.assetId);
          data = dataUri(a.bytes, a.type);
          images.set(p.assetId, data);
        }
        if(p.frame){
          let size=imageSizes.get(p.assetId);
          if(!size){
            const a=await loadAsset(p.assetId),{PDFDocument}=await import('pdf-lib'),probe=await PDFDocument.create();
            assertUprightImage(a.bytes,a.type);
            const img=a.type==='image/png'?await probe.embedPng(a.bytes):await probe.embedJpg(a.bytes);
            size={width:img.width,height:img.height};imageSizes.set(p.assetId,size);
          }
          assertImageDimensions(p.frame,size.width,size.height);
          const {viewport:v,draw:d}=imagePlacement(p,p.frame);
          page.addImage({data,x:canvasToInches(v.x),y:canvasToInches(v.y),w:canvasToInches(d.w),h:canvasToInches(d.h),
            sizing:{type:'crop',x:canvasToInches(v.x-d.x),y:canvasToInches(v.y-d.y),w:canvasToInches(v.w),h:canvasToInches(v.h)}});
          continue;
        }
        page.addImage({
          data,
          x,
          y,
          w: canvasToInches(p.w),
          h: canvasToInches(p.h),
          sizing: {
            type: "contain",
            w: canvasToInches(p.w),
            h: canvasToInches(p.h),
          },
        });
      }
    }
    const references = [...new Set([...s.sourceIds,...dataSourceIds(s)])].map((id, i) => {
      const src = sources.find((s) => s.id === id);
      return `[${i + 1}] ${src?.name || id} · SHA-256 ${src?.sha256 || "unknown"}`;
    });
    page.addNotes([s.notes, ...references].filter(Boolean).join("\n"));
  }
  return pptx;
}
/** Final export boundary: PptxGenJS 4 exposes fonts but no color-scheme API. */
export async function pptxBytes(doc: DeckDoc, sources: Source[] = [], loadAsset: typeof asset = asset): Promise<Uint8Array> {
  const pptx = await buildPptx(doc, sources, loadAsset);
  const bytes = await pptx.write({ outputType: "uint8array", compression: doc.design === "focus-v3" }) as Uint8Array;
  if (doc.design !== "focus-v3") return bytes;
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes);
  const colors = {dk1: doc.brand.ink, lt1: doc.brand.paper, dk2: doc.brand.ink, lt2: doc.brand.paper,
    accent1: doc.brand.primary, accent2: doc.brand.accent, accent3: doc.brand.ink,
    accent4: doc.brand.paper, accent5: doc.brand.primary, accent6: doc.brand.accent,
    hlink: doc.brand.primary, folHlink: doc.brand.accent};
  for (const path of Object.keys(zip.files).filter(p => /^ppt\/theme\/theme\d+\.xml$/.test(p))) {
    let xml = await zip.file(path)!.async("string");
    for (const [role, color] of Object.entries(colors))
      xml = xml.replace(new RegExp(`<a:${role}>[\\s\\S]*?</a:${role}>`, "g"), `<a:${role}><a:srgbClr val="${color.slice(1)}"/></a:${role}>`);
    zip.file(path, xml);
  }
  return zip.generateAsync({type: "uint8array", compression: "DEFLATE", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"});
}
export async function pdfBytes(
  doc: DeckDoc,
  regularBytes: ArrayBuffer | Uint8Array,
  boldBytes: ArrayBuffer | Uint8Array,
  loadAsset: (
    id: string,
  ) => Promise<{ bytes: ArrayBuffer; type: string }> = asset,
  monoBytes?: ArrayBuffer | Uint8Array,
): Promise<Uint8Array> {
  if (doc.design === "focus-v3" && !monoBytes) throw new Error("Для Focus 3 нужен шрифт IBM Plex Mono Medium.");
  const [{ PDFDocument, rgb, PDFHexString, pushGraphicsState, popGraphicsState, rectangle, clip, endPath, beginText, endText, setFontAndSize, setTextMatrix, setFillingRgbColor, showText }, { default: fontkit }] = await Promise.all([
    import("pdf-lib"),
    import("@pdf-lib/fontkit"),
  ]);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(doc.title);
  pdf.setAuthor("Lanka Studio");
  const features = doc.design === "focus-v3" ? {tnum: true} : undefined;
  const [regular, bold, mono] = await Promise.all([
    pdf.embedFont(regularBytes, { subset: true, features, customName: doc.design === "focus-v3" ? "LNKREG+IBMPlexSans-Regular" : undefined }),
    pdf.embedFont(boldBytes, { subset: true, features, customName: doc.design === "focus-v3" ? "LNKSBD+IBMPlexSans-SemiBold" : undefined }),
    monoBytes ? pdf.embedFont(monoBytes, {subset: true, features, customName: "LNKMON+IBMPlexMono-Medium"}) : undefined,
  ]);
  // pdf-lib encodes shaped glyphs but discards their kerning/position advances.
  // Keep fontkit's positions for Plex so PDF agrees with the browser's `kern`/`tnum`.
  const shapedFonts = doc.design === "focus-v3" ? [regularBytes, boldBytes, monoBytes!].map(bytes => fontkit.create(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))) : [];
  const scale = 0.6;
  const color = (v: string) =>
    rgb(
      parseInt(v.slice(1, 3), 16) / 255,
      parseInt(v.slice(3, 5), 16) / 255,
      parseInt(v.slice(5, 7), 16) / 255,
    );
  for (const [i, s] of doc.slides.entries()) {
    const page = pdf.addPage([W * scale, H * scale]),
      data = scene(s, doc.brand, i, doc.slides.length, doc.design);
    if (data.overflow)
      throw new Error(`Текст не помещается на слайде ${i + 1}.`);
    for (const p of data.items) {
      if (p.kind === "rect")
        page.drawRectangle({
          x: p.x * scale,
          y: (H - p.y - p.h) * scale,
          width: p.w * scale,
          height: p.h * scale,
          color: color(p.color),
        });
      else if (p.kind === "text") {
        const style = textStyle(p);
        const font = p.font === "mono" ? mono! : p.bold ? bold : regular;
        if (p.font) {
          const shapedFont = shapedFonts[p.font === "mono" ? 2 : p.bold ? 1 : 0];
          const run = shapedFont.layout(p.text, features);
          const encoded = font.encodeText(p.text).asString();
          const fontName = page.node.newFontDictionary(font.name, font.ref);
          const c = color(p.color), units = p.size * scale / shapedFont.unitsPerEm;
          let x = p.x * scale, y = (H - p.y - style.baseline) * scale;
          page.pushOperators(pushGraphicsState(), beginText(), setFontAndSize(fontName, p.size * scale), setFillingRgbColor(c.red, c.green, c.blue));
          run.positions.forEach((position, i) => {
            page.pushOperators(setTextMatrix(1, 0, 0, 1, x + position.xOffset * units, y + position.yOffset * units), showText(PDFHexString.of(encoded.slice(i * 4, (i + 1) * 4))));
            x += position.xAdvance * units + style.spacing * scale;
            y += position.yAdvance * units;
          });
          page.pushOperators(endText(), popGraphicsState());
        } else page.drawText(p.text, {
          x: p.x * scale,
          y: (H - p.y - style.baseline) * scale,
          size: p.size * scale,
          font,
          color: color(p.color),
        });
      } else {
        const a = await loadAsset(p.assetId);
        const img =
          a.type === "image/png"
            ? await pdf.embedPng(a.bytes)
            : await pdf.embedJpg(a.bytes);
        if(p.frame){
          assertUprightImage(a.bytes,a.type);
          assertImageDimensions(p.frame,img.width,img.height);
          const {viewport:v,draw:d}=imagePlacement(p,p.frame);
          page.pushOperators(pushGraphicsState(),rectangle(v.x*scale,(H-v.y-v.h)*scale,v.w*scale,v.h*scale),clip(),endPath());
          page.drawImage(img,{x:d.x*scale,y:(H-d.y-d.h)*scale,width:d.w*scale,height:d.h*scale});
          page.pushOperators(popGraphicsState());continue;
        }
        const fit = Math.min(p.w / img.width, p.h / img.height),
          w = img.width * fit,
          h = img.height * fit;
        page.drawImage(img, {
          x: (p.x + (p.w - w) / 2) * scale,
          y: (H - p.y - (p.h + h) / 2) * scale,
          width: w * scale,
          height: h * scale,
        });
      }
    }
  }
  return pdf.save();
}
export async function exportPdf(doc: DeckDoc) {
  const responses = await Promise.all(pdfFontFiles(doc.design).map(name => fetch(`/fonts/${name}`)));
  if (responses.some((r) => !r.ok))
    throw new Error("Не удалось загрузить шрифты.");
  const bytes = await pdfBytes(
    doc,
    await responses[0].arrayBuffer(),
    await responses[1].arrayBuffer(),
    asset,
    await responses[2]?.arrayBuffer(),
  );
  download(
    new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
    safeName(doc.title) + ".pdf",
  );
}

export async function exportPptx(doc: DeckDoc, sources: Source[] = []) {
  if (doc.design === "focus-v3") {
    const bytes = await pptxBytes(doc, sources);
    download(new Blob([new Uint8Array(bytes)], {type: "application/vnd.openxmlformats-officedocument.presentationml.presentation"}), safeName(doc.title) + ".pptx");
    return;
  }
  const pptx = await buildPptx(doc, sources);
  await pptx.writeFile({
    fileName: safeName(doc.title) + ".pptx",
    compression: true,
  });
}
