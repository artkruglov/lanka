import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import assert from "node:assert/strict";
await build({
  stdin: {
    contents:
      'export {scene} from "./lib/domain/scene";export{SlideCanvas}from"./components/slide-canvas";',
    resolveDir: process.cwd(),
  },
  outfile: ".test-build/history-render.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  tsconfig: "tsconfig.json",
});
const { scene, SlideCanvas } = await import(
    "../.test-build/history-render.mjs"
  ),
  { createElement } = await import("react"),
  { renderToStaticMarkup } = await import("react-dom/server");
const fonts = await Promise.all(
  [
    "IBMPlexSans-Regular.ttf",
    "IBMPlexSans-SemiBold.ttf",
    "IBMPlexMono-Medium.ttf",
  ].map((n) => readFile("public/fonts/" + n)),
);
const css = fonts
  .map(
    (b, i) =>
      `@font-face{font-family:"IBM Plex ${i === 2 ? "Mono" : "Sans"}";font-weight:${[400, 600, 500][i]};src:url(data:font/ttf;base64,${b.toString("base64")})}`,
  )
  .join("");
const browser = await chromium.launch({
    headless: true,
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  }),
  page = await browser.newPage({ viewport: { width: 1600, height: 900 } }),
  results = [];
try {
  for (const [name, id] of [
    ["cities", "7534ae80-b420-45e3-9933-83a56762a101"],
    ["roads", "7534ae80-b420-45e3-9933-83a56762a102"],
  ]) {
    const root = resolve("work/local-library/documents", id),
      project = JSON.parse(await readFile(root + "/project.json")),
      doc = project.state.doc,
      out = resolve("out/local-review", name + "-final");
    await mkdir(out, { recursive: true });
    const run = spawnSync("pdftoppm", [
      "-scale-to-x",
      "1600",
      "-scale-to-y",
      "900",
      "-png",
      root + "/exports/presentation.pdf",
      out + "/pdf",
    ]);
    assert.equal(run.status, 0, run.stderr.toString());
    for (const [i, slide] of doc.slides.entries()) {
      const data = scene(slide, doc.brand, i, doc.slides.length, doc.design);
      assert.equal(data.overflow, false);
      const canvas = renderToStaticMarkup(
        createElement(SlideCanvas, {
          slide,
          brand: doc.brand,
          design: doc.design,
          index: i,
          total: doc.slides.length,
        }),
      );
      const path = out + `/slide-${i + 1}.html`;
      await writeFile(
        path,
        `<!doctype html><meta charset="utf-8"><style>${css}body{margin:0}svg{display:block;width:1600px;height:900px}.slide-canvas text{font-family:"Lanka Sans",sans-serif}text{-webkit-font-smoothing:antialiased}</style>${canvas}`,
      );
      await page.goto(pathToFileURL(path).href);
      await page.evaluate(() => document.fonts.ready);
      const web = PNG.sync.read(
          await page.screenshot({ path: out + `/web-${i + 1}.png` }),
        ),
        pdf = PNG.sync.read(await readFile(out + `/pdf-${i + 1}.png`));
      const diff =
        pixelmatch(web.data, pdf.data, null, 1600, 900, {
          threshold: 0.1,
          includeAA: false,
        }) /
        (1600 * 900);
      results.push({
        name,
        slide: i + 1,
        revision: project.state.revision,
        meta: data.meta,
        diff,
        passed: diff <= 0.005,
      });
    }
  }
} finally {
  await browser.close();
}
await writeFile(
  "out/local-review/history-render-checks.json",
  JSON.stringify(results, null, 2),
);
console.log({
  slides: results.length,
  passed: results.filter((r) => r.passed).length,
  maxDiff: Math.max(...results.map((r) => r.diff)),
});
assert.ok(results.every((r) => r.passed));
