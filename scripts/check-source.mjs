import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {readdirSync} from 'node:fs';
const steps=[
 ['TypeScript',[resolve('node_modules/typescript/bin/tsc'),'--noEmit']],
 ['MCP and editor build',['scripts/build-project-mcp.mjs']],
 ['Editor, export and protocol checks',['--test',
  'scripts/normalize-npm-sbom.test.mjs',
  'scripts/project-mcp/canvas-layer.test.mjs',
  'scripts/project-mcp/canvas-align.test.mjs',
  'scripts/project-mcp/canvas-duplicate.test.mjs',
  'scripts/project-mcp/canvas-pagination.test.mjs',
  'scripts/project-mcp/canvas-text.test.mjs',
  'scripts/project-mcp/canvas-text-session.test.mjs',
  'scripts/project-mcp/image-placement.test.mjs',
  'scripts/project-mcp/publication-package.test.mjs',
  'scripts/project-mcp/revision-dependencies.test.mjs',
  'scripts/project-mcp/document-source-grant.test.mjs',
  'scripts/project-mcp/quality-corpus.test.mjs',
  'scripts/project-mcp/slide-intent.test.mjs',
  'scripts/project-mcp/brief-review.test.mjs',
  'scripts/project-mcp/colleague-review.test.mjs',
  'scripts/project-mcp/colleague-review-draft.test.mjs',
  'scripts/project-mcp/table-metadata-width.test.mjs',
  'scripts/project-mcp/proposal-summary.test.mjs',
  'scripts/project-mcp/proposal-review-state.test.mjs',
  'scripts/project-mcp/file-revision-dependencies.test.mjs',
  'scripts/project-mcp/history-comparison.test.mjs',
  'scripts/project-mcp/focus-fonts.test.mjs',
  ...readdirSync('runtime').filter(name=>name.endsWith('.test.mjs')).sort().map(name=>`runtime/${name}`),
  'scripts/project-mcp/login-completion.test.mjs',
 ]],
];
for(const [label,args] of steps){
 console.log(label);
 const result=spawnSync(process.execPath,args,{stdio:'inherit',timeout:180000});
 if(result.error){console.error(result.error.message);process.exit(1);}
 if(result.status!==0)process.exit(result.status??1);
}
console.log('Source checks passed. Database, real-agent, browser and Office acceptance run separately.');
