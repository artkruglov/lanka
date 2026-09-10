import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {build} from 'esbuild';
const input=process.argv[2],output=process.argv[3];if(!input||!output)throw Error('Usage: node scripts/check-corporate-corpus.mjs INPUT_DIRECTORY REPORT.json');
await mkdir('.test-build',{recursive:true});await build({entryPoints:['lib/project/quality-corpus.ts'],outfile:'.test-build/quality-corpus.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {assessCorpusCase}=await import('../.test-build/quality-corpus.mjs');
const corpus=JSON.parse(await readFile('quality/corporate-v1/cases.json','utf8'));
const read=async path=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return undefined;throw e;}};
const cases=[];for(const spec of corpus.cases){try{cases.push(assessCorpusCase(spec,await read(resolve(input,spec.id+'.json')),spec.requiresBaseline?await read(resolve(input,spec.id+'.baseline.json')):undefined));}catch{cases.push({caseId:spec.id,status:'invalid-output',humanAcceptance:'not-assessed',error:'JSON input could not be read.'});}}
const report={checkedAt:new Date().toISOString(),corpusVersion:corpus.version,scope:'Structural assessment of supplied outputs; not a model run, user interview, Office review or time measurement.',humanAccepted:false,cases};
await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({cases:cases.length,missing:cases.filter(c=>c.status==='missing').length,technicalIssues:cases.filter(c=>['technical-issues','invalid-output'].includes(c.status)).length,humanAccepted:false}));
if(cases.some(c=>c.status!=='awaiting-human-review'))process.exitCode=1;
