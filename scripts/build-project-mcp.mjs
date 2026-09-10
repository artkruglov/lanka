import {buildFocusFonts} from './build-focus-fonts.mjs';
import { build } from "esbuild";
import {createHash} from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
// Fingerprint the actual export bundle plus resolved dependencies, including uncommitted source changes.
const renderer=await build({entryPoints:["scripts/project-mcp/export.ts"],bundle:true,platform:"node",format:"esm",packages:"external",write:false,tsconfig:"tsconfig.json"});
const buildHash=createHash("sha256").update(renderer.outputFiles[0].contents).update(await readFile("package-lock.json")).digest("hex");
const exportBuild={buildHash,packageVersion:JSON.parse(await readFile("package.json","utf8")).version};
const exportDefine={__LANKA_EXPORT_BUILD__:JSON.stringify(exportBuild)};
await mkdir(".project-runtime",{recursive:true});
// Archive a self-contained layout renderer, including package metrics and geometry dependencies.
await build({entryPoints:["lib/domain/scene.ts"],outfile:".project-runtime/design-scene.mjs",bundle:true,platform:"node",format:"esm",tsconfig:"tsconfig.json"});
exportDefine.__LANKA_SCENE_BUILD__=JSON.stringify(createHash("sha256").update(await readFile(".project-runtime/design-scene.mjs")).digest("hex"));
await buildFocusFonts(".project-runtime/focus3-fonts.zip");
await writeFile(".project-runtime/export-build.json",JSON.stringify(exportBuild));

await build({
  define:exportDefine,
  entryPoints: ["scripts/project-mcp/server.ts"],
  outfile: ".project-runtime/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  tsconfig: "tsconfig.json",
});
await build({define:exportDefine,entryPoints: ["scripts/project-mcp/web.ts"], outfile: ".project-runtime/web.mjs", bundle: true, platform: "node", format: "esm", packages: "external", tsconfig: "tsconfig.json"});
await build({entryPoints: ["components/project-workbench.tsx"], outfile: ".project-runtime/project.js", bundle: true, platform: "browser", format: "iife", minify: true,
  // CreatPPT also exports Node extractors. UI imports geometry only; builtin imports have no side effects.
  plugins: [{name: "unused-node-exports", setup(build) {build.onResolve({filter: /^(fs\/promises|path)$/}, args => ({path: args.path, external: true, sideEffects: false}));}}], tsconfig: "tsconfig.json", define: {"process.env.NODE_ENV": '"production"'}});
const css = await postcss([tailwind()]).process(await readFile("app/globals.css", "utf8"), {from: "app/globals.css", to: ".project-runtime/project.css"});
await writeFile(".project-runtime/project.css", css.css + await readFile("components/project-workbench.css", "utf8") + await readFile("components/ui-refresh.css", "utf8"));
process.stdout.write("Project-folder MCP and local editor compiled.\n");

await build({entryPoints:["scripts/migrate-local-library.ts"],outfile:".project-runtime/migrate-library.mjs",bundle:true,platform:"node",format:"esm",packages:"external",tsconfig:"tsconfig.json"});

await build({entryPoints:["scripts/provision-organization.ts"],outfile:".project-runtime/provision-organization.mjs",bundle:true,platform:"node",format:"esm",packages:"external",tsconfig:"tsconfig.json"});

await build({define:exportDefine,entryPoints:["scripts/self-hosted-server.ts"],outfile:".project-runtime/self-hosted-server.mjs",bundle:true,platform:"node",format:"esm",packages:"external",tsconfig:"tsconfig.json"});

await build({entryPoints:["scripts/migrate-self-hosted.ts"],outfile:".project-runtime/migrate-self-hosted.mjs",bundle:true,platform:"node",format:"esm",packages:"external",tsconfig:"tsconfig.json"});

await build({entryPoints:["scripts/grant-self-hosted-runtime.ts"],outfile:".project-runtime/grant-self-hosted-runtime.mjs",bundle:true,platform:"node",format:"esm",packages:"external",tsconfig:"tsconfig.json"});

await build({entryPoints:["scripts/check-self-hosted-health.ts"],outfile:".project-runtime/check-self-hosted-health.mjs",bundle:true,platform:"node",format:"esm",packages:"external",tsconfig:"tsconfig.json"});
