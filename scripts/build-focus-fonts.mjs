import JSZip from 'jszip';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export async function buildFocusFonts(output){
 const files=['IBMPlexSans-Regular.ttf','IBMPlexSans-SemiBold.ttf','IBMPlexMono-Medium.ttf','OFL-IBMPlexSans.txt','OFL-IBMPlexMono.txt'];
 const zip=new JSZip(),manifest={format:'lanka-focus3-fonts/v1',files:[]};
 const add=(name,bytes)=>zip.file(name,bytes,{date:new Date('2026-01-01T00:00:00Z')});
 for(const file of files){const bytes=await readFile(new URL('../public/fonts/'+file,import.meta.url));add(file,bytes);manifest.files.push({name:file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
 add('README.txt',`Шрифты Lanka Focus 3\n\nРаспакуйте архив. Откройте три файла .ttf и установите их средствами вашей операционной системы, затем заново откройте презентацию в PowerPoint или Keynote. Если установка ограничена политикой компании, передайте комплект администратору.\n\nАрхив содержит IBM Plex Sans Regular и SemiBold, IBM Plex Mono Medium и исходные лицензии OFL. Шрифты не устанавливаются автоматически и не встраиваются в PPTX этой операцией. Получателю PPTX тоже нужны эти шрифты. Интервалы могут различаться между редакторами даже после установки; для точной композиции используйте PDF.\n\nЭтот комплект относится к Focus 3. Произвольные корпоративные шрифты в него не входят.\n`);
 add('manifest.json',JSON.stringify(manifest,null,2)+'\n');
 await writeFile(output,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
 return manifest;
}
