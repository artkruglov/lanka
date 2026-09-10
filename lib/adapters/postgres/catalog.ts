import {z} from 'zod';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../../domain/canonical-json';
import type {ChatDatabase,DbTx} from './chat-database';
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
export async function catalogInfo(db:ChatDatabase){
 const r=await db.pool.query('SELECT source_root,migration_id,source_hash,report FROM lanka.workspace_catalogs WHERE tenant_id=$1 AND owner_id=$2',[db.tenant,db.owner]);return r.rows[0]??null;
}
export async function catalogFolders(db:ChatDatabase){
 const r=await db.pool.query('SELECT id,name FROM lanka.catalog_folders WHERE tenant_id=$1 AND owner_id=$2 ORDER BY name,id',[db.tenant,db.owner]);return r.rows as {id:string;name:string}[];
}
export async function resolveMaterialId(db:ChatDatabase,id:string){
 if(!/^[a-f0-9-]{36}$/i.test(id))return id;
 const r=await db.pool.query('SELECT material_id FROM lanka.material_aliases WHERE tenant_id=$1 AND owner_id=$2 AND alias_id=$3',[db.tenant,db.owner,id]);return r.rows[0]?.material_id??id;
}
export async function checkCatalogFolder(db:ChatDatabase,c:DbTx,id:string|null){
 if(!id)return;
 const active=await c.query('SELECT 1 FROM lanka.workspace_catalogs WHERE tenant_id=$1 AND owner_id=$2',[db.tenant,db.owner]);
 if(!active.rowCount)return; // Legacy mixed mode still validates its file folder in LocalWorkspace.
 const folder=await c.query('SELECT 1 FROM lanka.catalog_folders WHERE tenant_id=$1 AND owner_id=$2 AND id=$3',[db.tenant,db.owner,id]);
 if(!folder.rowCount)throw Error('Папка недоступна.');
}
export async function catalogReceipt(db:ChatDatabase,requestId:string,command:unknown,c:DbTx|typeof db.pool=db.pool){
 const r=await c.query('SELECT fingerprint,result FROM lanka.catalog_receipts WHERE tenant_id=$1 AND owner_id=$2 AND request_id=$3',[db.tenant,db.owner,requestId]);
 if(!r.rowCount)return null;if(r.rows[0].fingerprint!==hash(command))throw Error('Ключ повтора уже использован для другого действия.');return {result:r.rows[0].result};
}
export async function mutateFolder(db:ChatDatabase,requestId:string,input:unknown){
 z.string().uuid().parse(requestId);
 const name=z.string().trim().min(1).max(180),command=z.discriminatedUnion('action',[z.object({action:z.literal('create_folder'),name}).strict(),z.object({action:z.literal('rename_folder'),id:z.string().uuid(),name}).strict()]).parse(input);
 return db.tx(async c=>{
  const active=await c.query('SELECT 1 FROM lanka.workspace_catalogs WHERE tenant_id=$1 AND owner_id=$2',[db.tenant,db.owner]);if(!active.rowCount)throw Error('Серверный каталог не настроен.');
  const old=await catalogReceipt(db,requestId,command,c);if(old)return old.result;
  const used=await c.query('SELECT 1 FROM lanka.command_receipts WHERE tenant_id=$1 AND owner_id=$2 AND request_id=$3 UNION ALL SELECT 1 FROM lanka.imported_project_receipts WHERE tenant_id=$1 AND owner_id=$2 AND request_id=$3',[db.tenant,db.owner,requestId]);if(used.rowCount)throw Error('Ключ повтора уже использован для другого действия.');
  let result:unknown={ok:true};
  if(command.action==='create_folder'){
   await c.query('INSERT INTO lanka.catalog_folders(tenant_id,owner_id,id,name) VALUES($1,$2,$3,$4)',[db.tenant,db.owner,requestId,command.name]);result={id:requestId};
  }else{const r=await c.query('UPDATE lanka.catalog_folders SET name=$4 WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 RETURNING id',[db.tenant,db.owner,command.id,command.name]);if(!r.rowCount)throw Error('Папка недоступна.');}
  await c.query('INSERT INTO lanka.catalog_receipts(tenant_id,owner_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)',[db.tenant,db.owner,requestId,hash(command),JSON.stringify(result)]);return result;
 });
}
