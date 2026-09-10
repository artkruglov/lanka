import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {readFile,access} from 'node:fs/promises';import {constants} from 'node:fs';import {resolve,isAbsolute} from 'node:path';
const exec=promisify(execFile);
/** Suggest only the pinned version; do not install software or open a profile. */
export async function discoverCompanionRuntime(){
 const version=JSON.parse(await readFile(new URL('./package.json',import.meta.url),'utf8')).dependencies['@openai/codex'],candidates=[resolve(import.meta.dirname,'node_modules/.bin/codex')];
 try{const found=(await exec('which',['codex'],{timeout:3000,maxBuffer:4096})).stdout.trim();if(isAbsolute(found))candidates.push(found);}catch{}
 for(const command of [...new Set(candidates)])try{await access(command,constants.X_OK);const result=await exec(command,['--version'],{timeout:3000,maxBuffer:4096});if(result.stdout.trim()==='codex-cli '+version)return {command,version};}catch{}
 return null;
}
