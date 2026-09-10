import {readFile,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {ChatDatabase} from '../lib/adapters/postgres/chat-database';
import {localChatConfigSchema} from '../lib/agents/local-config';
import {inspectLibraryMigration,migrateLibrary} from './project-mcp/migrate-library';
const args=process.argv.slice(2),value=(flag:string)=>args[args.indexOf(flag)+1];
if(!args.includes('--config')||(!args.includes('--check')&&!args.includes('--apply'))||args.includes('--check')&&args.includes('--apply'))throw Error('Usage: node .project-runtime/migrate-library.mjs --config /absolute/config.json --check | --apply --expected-hash SHA256 [--report /absolute/report.json]');
const config=localChatConfigSchema.parse(JSON.parse(await readFile(resolve(value('--config')),'utf8'))),db=new ChatDatabase(config);
const reportFile=args.includes('--report')?await open(resolve(value('--report')),'wx',0o600):null;
try{
 await db.init();
 const result=args.includes('--apply')?await migrateLibrary(db,config.workspaceRoot,value('--expected-hash')):await inspectLibraryMigration(db,config.workspaceRoot);
 if(reportFile){await reportFile.writeFile(JSON.stringify(result,null,2)+'\n');await reportFile.sync();}
 // Do not expose credentials or document contents in terminal logs.
 console.log(JSON.stringify({status:result.status,sourceHash:result.sourceHash,folders:result.folders,documents:result.documents.length,bytes:result.bytes},null,2));
}finally{await reportFile?.close();await db.close();}
