/** bun scripts/render-fixtures.ts [output-directory]
 * Real SVG/PDF/PPTX exports of the supplied Focus 3 deck and all eleven fixtures.
 * Never promotes golden-candidate to an accepted golden.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { focusV3Scene } from "../lib/domain/focus-v3";
import { validateDoc, lintDoc, blankSlide } from "../lib/domain/model";
import { pdfFontFiles } from "../lib/domain/scene-typography";
import { pdfBytes, pptxBytes } from "../lib/export";
import { slideSvg } from "../lib/export-svg";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SlideCanvas } from "../components/slide-canvas";
import fixtures from "../design-packs/focus-v3/fixtures.json";
import example from "../lib/examples/lanka-sales-focus-v3.json";
import policy from "../design-packs/focus-v3/tokens.json";

const out = resolve(process.argv[2] ?? "out/focus-v3");
await mkdir(out, {recursive: true});
const doc = validateDoc(example.doc);
const fixtureDoc = validateDoc({...doc, id: "focus-v3-fixtures", title: "Focus 3 fixtures", slides: fixtures.map(f => ({...blankSlide(), ...f}))});
const fonts = await Promise.all(pdfFontFiles(doc.design).map(name => readFile(resolve("public/fonts", name))));
const fontCss = fonts.map((bytes, i) => `@font-face{font-family:"IBM Plex ${i === 2 ? "Mono" : "Sans"}";font-weight:${[400, 600, 500][i]};src:url("data:font/ttf;base64,${bytes.toString("base64")}") format("truetype")}`).join("\n");
const rows = [];
let bad = 0;
for (const [name, deck] of [["deck", doc], ["fixture", fixtureDoc]] as const) {
  for (const [i, slide] of deck.slides.entries()) {
    const data = focusV3Scene(slide, deck.brand, i, deck.slides.length);
    const m = data.meta;
    rows.push({name, slide: i + 1, layout: slide.layout, overflow: data.overflow, ...m});
    if (data.overflow) bad++;
    if (name === "deck" && (m.titleFill > policy.policy.maxTitleFill || m.occupancy < policy.policy.occupancy[0] || m.occupancy > policy.policy.occupancy[1] || m.primaryTextClasses > policy.policy.primaryTextClassesPerSlide)) bad++;
    const file = `${name}-${String(i + 1).padStart(2, "0")}-${slide.layout}`;
    const svg = slideSvg(slide, deck.brand, i, deck.slides.length, deck.design, fontCss);
    await writeFile(resolve(out, `${file}.svg`), svg);
    const canvas = renderToStaticMarkup(createElement(SlideCanvas, {slide, brand: deck.brand, index: i, total: deck.slides.length, design: deck.design}));
    // Include the application's legacy CSS rule to catch a Plex font attribute being overridden.
    await writeFile(resolve(out, `${file}.html`), `<!doctype html><meta charset="utf-8"><style>${fontCss}body{margin:0}svg{display:block;width:1600px;height:900px}.slide-canvas text{font-family:"Lanka Sans",sans-serif}text{-webkit-font-smoothing:antialiased}</style>${canvas}`);
  }
  await writeFile(resolve(out, `${name}.pdf`), await pdfBytes(deck, fonts[0], fonts[1], undefined, fonts[2]));
  await writeFile(resolve(out, `${name}.pptx`), await pptxBytes(deck));
}
const lint = lintDoc(doc);
if (lint.some(i => i.severity === "error")) bad++;
await writeFile(resolve(out, "metrics.json"), JSON.stringify({rows, lint}, null, 2));
console.table(rows);
console.log(JSON.stringify({slides: rows.length, failures: bad, lint, out}, null, 2));
if (bad) process.exitCode = 1;
