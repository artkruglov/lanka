import {spawn} from 'node:child_process';import {resolve} from 'node:path';
import {checkCompanionInstallation} from './companion-install-check.mjs';
function runNpm(args){return new Promise((resolve,reject)=>{const child=spawn('npm',args,{stdio:'inherit'});const interrupt=()=>child.kill('SIGINT');process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);const cleanup=()=>{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);};child.once('error',()=>{cleanup();reject(Error('Не удалось запустить npm. Проверьте установку Node и npm.'));});child.once('exit',(code,signal)=>{cleanup();code===0&&!signal?resolve():reject(Error('Установка npm не завершена. Проверьте вывод выше и повторите установку.'));});});}
/** Explicit local installation from the shipped lock. No login, profile copying or model turn. */
export async function installCompanion({directory=import.meta.dirname,run=runNpm,verify=checkCompanionInstallation}={}){
 await run(['ci','--prefix',directory,'--include=optional','--fetch-timeout=900000','--no-audit','--no-fund']);
 return verify({directory});
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 try{if(process.argv.length!==2)throw Error('Usage: node runtime/companion-install.mjs');console.log('Скачиваем закреплённый Codex. Загрузка бинарного пакета может занять несколько минут. Вход и модель не запускаются.');const result=await installCompanion();console.log('Codex '+result.version+' установлен и проверен. Далее: node runtime/companion-setup.mjs');}catch(error){console.error(error.message);process.exitCode=1;}
}
