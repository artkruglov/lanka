import {readFile} from 'node:fs/promises';import {resolve} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const exec=promisify(execFile);
/** Verify the packaged runtime specifically; never mask failure with a global installation. */
export async function checkCompanionInstallation({directory=import.meta.dirname,execute=exec}={}){
 const version=JSON.parse(await readFile(resolve(directory,'package.json'),'utf8')).dependencies['@openai/codex'];
 try{const result=await execute(process.execPath,[resolve(directory,'node_modules/@openai/codex/bin/codex.js'),'--version'],{timeout:10000,maxBuffer:4096});if(result.stdout.trim()!=='codex-cli '+version)throw Error('Version mismatch');}
 catch{throw Error('Codex в комплекте не готов. npm мог пропустить платформенный пакет даже при успешном завершении. Проверьте загрузку optional dependencies и повторите npm ci --prefix runtime. Требуется версия '+version+'. Системный Codex этой проверкой не используется.');}
 return {installed:true,version,platform:process.platform,arch:process.arch};
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 try{if(process.argv.length!==2)throw Error('Usage: node runtime/companion-install-check.mjs');console.log(JSON.stringify(await checkCompanionInstallation()));}catch(error){console.error(error.message);process.exitCode=1;}
}
