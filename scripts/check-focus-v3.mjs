/** npm run test:focus-v3. Requires Chromium/Chrome and Poppler (pdftoppm).
 * CHROME_PATH overrides the executable; defaults to system Chrome on macOS or Playwright Chromium.
 * Goldens are supplied candidates, never overwritten by this command.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const out = resolve("out/focus-v3");
await mkdir(out, {recursive: true});
await mkdir(".test-build", {recursive: true});
await build({entryPoints: ["scripts/render-fixtures.ts"], outfile: ".test-build/render-fixtures.mjs", bundle: true, platform: "node", format: "esm", packages: "external", tsconfig: "tsconfig.json"});
function run(cmd, args) {
  const r = spawnSync(cmd, args, {encoding: "utf8", timeout: 60000});
  if (r.status !== 0) throw new Error(`${cmd}: ${r.error?.message ?? r.stderr ?? r.stdout}`);
  return r.stdout;
}
await writeFile(resolve(out, "render.log"), run(process.execPath, [".test-build/render-fixtures.mjs"]));
const metrics = JSON.parse(await readFile(resolve(out, "metrics.json"), "utf8"));
await mkdir(resolve(out, "web-png"), {recursive: true});
await mkdir(resolve(out, "pdf-png"), {recursive: true});
for (const name of ["deck", "fixture"])
  run("pdftoppm", ["-scale-to-x", "1600", "-scale-to-y", "900", "-png", resolve(out, `${name}.pdf`), resolve(out, `pdf-png/${name}`)]);
const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.CHROME_PATH || (existsSync(systemChrome) ? systemChrome : undefined);
const browser = await chromium.launch({headless: true, executablePath});
const report = [];
try {
  const page = await browser.newPage({viewport: {width: 1600, height: 900}, deviceScaleFactor: 1});
  for (const row of metrics.rows) {
    const stem = `${row.name}-${String(row.slide).padStart(2, "0")}-${row.layout}`;
    await page.goto(pathToFileURL(resolve(out, `${stem}.html`)).href);
    await page.evaluate(() => document.fonts.ready);
    const families = await page.locator("text").evaluateAll(elements => [...new Set(elements.map(e => getComputedStyle(e).fontFamily))]);
    assert.ok(families.every(f => f.includes("IBM Plex")), `${stem}: ${families}`);
    const web = await page.screenshot({path: resolve(out, `web-png/${stem}.png`)});
    const golden = PNG.sync.read(await readFile(resolve("design-packs/focus-v3/golden-candidate", `${stem}.png`)));
    const pdfName = `${row.name}-${String(row.slide).padStart(row.name === "fixture" ? 2 : 1, "0")}.png`;
    for (const [format, bytes] of [["web", web], ["pdf", await readFile(resolve(out, "pdf-png", pdfName))]]) {
      const actual = PNG.sync.read(bytes);
      assert.deepEqual([actual.width, actual.height], [golden.width, golden.height]);
      const diff = new PNG({width: actual.width, height: actual.height});
      const pixels = pixelmatch(actual.data, golden.data, diff.data, actual.width, actual.height, {threshold: 0.1, includeAA: false});
      const fraction = pixels / actual.width / actual.height;
      report.push({slide: stem, format, differingPixels: pixels, fraction, passed: fraction <= 0.005});
      if (fraction > 0.005) await writeFile(resolve(out, `${stem}-${format}-diff.png`), PNG.sync.write(diff));
    }
  }
} finally { await browser.close(); }
await writeFile(resolve(out, "golden-diff.json"), JSON.stringify({maxDifferentFraction: 0.005, colorThreshold: 0.1, ignoreAntialiasing: true, report}, null, 2));
for (const format of ["web", "pdf"]) {
  const rows = report.filter(r => r.format === format);
  console.log(`${format}: ${rows.filter(r => r.passed).length}/${rows.length}; max diff ${(Math.max(...rows.map(r => r.fraction)) * 100).toFixed(3)}% (limit 0.5%)`);
}
assert.ok(report.every(r => r.passed), `Golden comparison failed: ${report.filter(r => !r.passed).map(r => `${r.slide} ${r.format}`).join(", ")}`);
