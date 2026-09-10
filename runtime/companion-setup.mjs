import {discoverCompanionRuntime} from './companion-discovery.mjs';
import {readFile,lstat,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {companionConnection} from '../lib/project/companion-connection.mjs';
import {loadCompanionConfig} from './companion-daemon.mjs';
import {CompanionFault,companionDiagnostic} from './companion-faults.mjs';
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
/** Downloaded connection is data. Native configuration is supplied locally by the user. */
export async function configureCompanion({connectionPath,directory,command,codexHome,cwd,model}){
 if(![connectionPath,directory,command].every(p=>typeof p==='string'&&isAbsolute(p))||typeof model!=='string'||!model.trim())throw new CompanionFault('CONFIGURATION');
 if([codexHome,cwd].some(p=>p!==undefined&&(typeof p!=='string'||!isAbsolute(p))))throw new CompanionFault('CONFIGURATION');
 const source=await lstat(connectionPath);if(!source.isFile()||source.isSymbolicLink()||source.size>16384)throw new CompanionFault('CONFIGURATION');
 const connection=companionConnection(JSON.parse(await readFile(connectionPath,'utf8')));
 if(Date.parse(connection.expiresAt)<=Date.now())throw new CompanionFault('ACCESS_DENIED');
 // Do not overwrite an existing companion or touch its checkpoints.
 await mkdir(directory,{mode:0o700});
 try{
  const target=await realpath(directory),copied=join(target,'connection.json'),configPath=join(target,'companion.json');
  if(codexHome===undefined){codexHome=join(target,'profile');await mkdir(codexHome,{mode:0o700});}
  if(cwd===undefined){cwd=join(target,'workspace');await mkdir(cwd,{mode:0o700});}
  await writeFile(copied,JSON.stringify(connection,null,2)+'\n',{flag:'wx',mode:0o600});
  await writeFile(configPath,JSON.stringify({connectionPath:copied,stateDir:join(target,'state'),command,codexHome,cwd,model:model.trim()},null,2)+'\n',{flag:'wx',mode:0o600});
  await loadCompanionConfig(configPath);
  return {configPath};
 }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}
export function companionSetupCommands(configPath){
 const entry=resolve(import.meta.dirname,'companion-daemon.mjs');
 return {panel:`${quote(process.execPath)} ${quote(resolve(import.meta.dirname,'companion-panel.mjs'))} --config ${quote(configPath)}`,check:`${quote(process.execPath)} ${quote(entry)} --check --config ${quote(configPath)}`,start:`${quote(process.execPath)} ${quote(entry)} --config ${quote(configPath)}`};
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 const rl=createInterface({input:stdin,output:stdout});
 try{
  if(process.argv.length!==2||!stdin.isTTY)throw new CompanionFault('CONFIGURATION');
  stdout.write('Настройка вашего агента для беседы Lanka. Модель не запускается.\nУкажите абсолютные пути. Каталог настройки должен быть новым.\n');
  const detected=await discoverCompanionRuntime();
  if(detected)stdout.write(`Найден Codex ${detected.version}: ${detected.command}\n`);
  const options={connectionPath:(await rl.question('Скачанный файл подключения: ')).trim(),directory:(await rl.question('Новый приватный каталог настройки: ')).trim(),model:(await rl.question('Модель: ')).trim(),command:detected?.command};
  const advanced=(await rl.question('Изменить runtime, профиль или рабочий каталог? [нет]: ')).trim().toLowerCase();
  if(!['','нет','no','n','да','yes','y'].includes(advanced))throw new CompanionFault('CONFIGURATION');
  if(['да','yes','y'].includes(advanced)){
   options.command=(await rl.question(`Исполняемый файл Codex${detected?' [Enter: найденный runtime]':''}: `)).trim()||detected?.command;
   options.codexHome=(await rl.question('Отдельный профиль [Enter: создать новый профиль Lanka]: ')).trim()||undefined;
   options.cwd=(await rl.question('Рабочий каталог [Enter: создать новый каталог Lanka]: ')).trim()||undefined;
  }else if(!detected)options.command=(await rl.question('Путь к установленному Codex (автоматически не найден): ')).trim();
  stdout.write('Пустые профиль и рабочий каталог будут созданы внутри нового каталога настройки. Вход выполните в панели.\n');
  const {configPath}=await configureCompanion(options),commands=companionSetupCommands(configPath);
  stdout.write(`\nКонфигурация создана. Откройте панель управления:\n${commands.panel}\n\nВ панели: «Войти в Codex» → «Проверить подключение» → «Запустить».\n\nПроверка без панели:\n${commands.check}\n\nЗапуск без панели:\n${commands.start}\n\nДержите терминал открытым. Для остановки используйте Ctrl+C.\n`);
 }catch(error){stderrDiagnostic(error instanceof CompanionFault?error:new CompanionFault('CONFIGURATION'));process.exitCode=1;}finally{rl.close();}
}
function stderrDiagnostic(error){process.stderr.write(JSON.stringify(companionDiagnostic(error))+'\n');}
