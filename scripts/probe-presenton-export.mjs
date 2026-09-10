// Export a prepared HTML fixture through Presenton's installed converter.
// Does not install dependencies or change Lanka's renderer.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [entry, input, output, chrome] = process.argv.slice(2);
if (!entry || !input || !output || !chrome) {
  console.error("Usage: node scripts/probe-presenton-export.mjs <export-core/dist/index.js> <wrapped-slide.html> <output-directory> <chrome-executable>");
  process.exit(1);
}
try {
  const { runTask } = await import(pathToFileURL(path.resolve(entry)).href);
  const outputDirectory = path.resolve(output);
  await fs.mkdir(outputDirectory, { recursive: true });
  const html = await fs.readFile(input, "utf8");
  const result = await runTask(
    { type: "html-to-any", html, format: "pptx", title: "presenton-edited-html" },
    { outputDirectory, browserLaunchOptions: { executablePath: path.resolve(chrome) } },
  );
  await fs.writeFile(path.join(outputDirectory, "receipt.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} catch (error) {
  // The distributed bundle is obfuscated and its one-line stack is enormous.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
