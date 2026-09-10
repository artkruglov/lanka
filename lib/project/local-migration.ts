import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname,basename} from 'node:path';
export const migrationMarker='lanka-migration.json';
export async function readMigration(root:string){
 let file;try{file=await open(join(root,migrationMarker),constants.O_RDONLY|constants.O_NOFOLLOW);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
 try{if((await file.stat()).size>10_000)throw Error('Неверный маркер переноса.');const m=JSON.parse(await file.readFile('utf8'));if(m.format!=='lanka-library-migration/v1'||!['frozen','committed'].includes(m.phase)||typeof m.sourceHash!=='string'||typeof m.targetHash!=='string')throw Error('Неверный маркер переноса.');return m as {format:string;phase:string;sourceHash:string;targetHash:string;migrationId:string;tenantId:string;ownerId:string};}finally{await file.close();}
}
export async function assertLocalAvailable(root:string,project=false){
 const library=project&&basename(dirname(root))==='documents'?dirname(dirname(root)):root;
 if(await readMigration(library))throw Error('Библиотека переносится или уже перенесена в PostgreSQL. Файловая копия закрыта для работы; подключите серверную библиотеку.');
}
