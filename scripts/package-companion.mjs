import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {resolve,relative,dirname,isAbsolute,join} from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import JSZip from 'jszip';
const root=resolve(import.meta.dirname,'..');
/** Copy only the static source dependency graph, never runtime state or user configuration. */
export async function packageCompanion(destination){
 if(!isAbsolute(destination))throw Error('Absolute new output directory required');
 const files=new Map(),queue=['runtime/companion-reclaim.mjs','runtime/companion-inspect.mjs','runtime/companion-install.mjs','runtime/companion-install-check.mjs','runtime/companion-setup.mjs','runtime/companion-panel.mjs','runtime/companion-daemon.mjs','runtime/bridge-mcp.mjs'];
 while(queue.length){
  const path=queue.shift();if(files.has(path))continue;
  const data=await readFile(join(root,path));files.set(path,data);
  const ast=ts.createSourceFile(path,data.toString('utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const include=specifier=>{
   if(specifier.startsWith('node:'))return;
   if(!specifier.startsWith('.'))throw Error('Unpackaged dependency: '+specifier);
   const dependency=relative(root,resolve(root,dirname(path),specifier));
   if(dependency.startsWith('..')||isAbsolute(dependency)||!dependency.endsWith('.mjs'))throw Error('Unsupported source dependency');
   queue.push(dependency);
  };
  const visit=node=>{if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier){if(!ts.isStringLiteral(node.moduleSpecifier))throw Error('Nonliteral module');include(node.moduleSpecifier.text);}if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword){if(node.arguments.length!==1||!ts.isStringLiteral(node.arguments[0]))throw Error('Dynamic module requires explicit packaging');include(node.arguments[0].text);}ts.forEachChild(node,visit);};visit(ast);
 }
 for(const path of ['runtime/package.json','runtime/package-lock.json','docs/COMPANION_LOCAL.md'])files.set(path,await readFile(join(root,path)));
 // The application worker and its checks are not shipped in this standalone kit.
 const runtimePackage=JSON.parse(files.get('runtime/package.json'));
 runtimePackage.scripts={
  'install:runtime':'node companion-install.mjs',
  check:'node companion-install-check.mjs',
  setup:'node companion-setup.mjs',
  panel:'node companion-panel.mjs',
  start:'node companion-daemon.mjs',
  inspect:'node companion-inspect.mjs',
  recover:'node companion-reclaim.mjs',
 };
 files.set('runtime/package.json',Buffer.from(JSON.stringify(runtimePackage,null,2)+'\n'));
 files.set('README.md',Buffer.from(`# Lanka companion · локальный комплект\n\nНужен Node ≥22.13. Комплект предназначен для локальной проверки администратором; это не опубликованный релиз. Авторизация, документы и ключи в комплект не включены.\n\n1. Если закреплённый Codex ещё не установлен, из этой папки выполните \`node runtime/companion-install.mjs\`. Установщик запускает npm ci и проверяет именно бинарник комплекта: npm может завершиться успешно без платформенного пакета. Команда скачает runtime из npm; для закрытого контура используйте утверждённый компанией registry или заранее установленный executable.\n2. В беседе Lanka выдайте доступ и скачайте подключение к беседе.\n3. Из этой папки выполните \`node runtime/companion-setup.mjs\`. Укажите скачанный файл, новый приватный каталог и модель.\n4. Выполните напечатанную команду панели. В панели войдите в отдельный профиль Codex, выберите модель, проверьте подключение и запустите исполнителя.\n5. Вернитесь в Lanka и отправьте поручение. Терминал панели должен оставаться открытым.\n\nПодробности, отмена и восстановление: [инструкция](docs/COMPANION_LOCAL.md). Комплект можно переместить до настройки; после перемещения обновите пути к runtime в конфигурации. Не размещайте приватный каталог внутри комплекта и не пересылайте его.\n\nMANIFEST.json содержит SHA-256 файлов для проверки целостности. Это не цифровая подпись и не подтверждение доверия к отправителю. Лицензия открытого выпуска ещё требует решения владельца; данный комплект не публикуется автоматически.\n`));
 const manifest={format:'lanka-companion-package/v1',codexVersion:JSON.parse(files.get('runtime/package.json')).dependencies['@openai/codex'],files:Object.fromEntries([...files].sort(([a],[b])=>a.localeCompare(b)).map(([path,data])=>[path,createHash('sha256').update(data).digest('hex')]))};
 files.set('MANIFEST.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
 await mkdir(destination,{mode:0o700});
 try{
  const zip=new JSZip();for(const [path,data] of files){const target=join(destination,'lanka-companion',path);await mkdir(dirname(target),{recursive:true});await writeFile(target,data,{flag:'wx'});zip.file('lanka-companion/'+path,data,{date:new Date('2026-01-01T00:00:00Z')});}
  const archive=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});await writeFile(join(destination,'lanka-companion.zip'),archive,{flag:'wx'});
  return {directory:join(destination,'lanka-companion'),archive:join(destination,'lanka-companion.zip'),files:files.size,bytes:archive.length};
 }catch(error){await rm(destination,{recursive:true,force:true});throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 try{if(process.argv.length!==3)throw Error('Usage: node scripts/package-companion.mjs /absolute/new-directory');console.log(JSON.stringify(await packageCompanion(resolve(process.argv[2]))));}catch(error){console.error(error.message);process.exitCode=1;}
}
