import {bindRevisionDesignIn} from './revision-design-package';
import {AsyncLocalStorage} from 'node:async_hooks';
import {loadRestorableRevisionIn,readRevisionAssetIn,readRevisionDependenciesIn} from './revision-dependencies';
import {captureRevisionDependencies} from '../../project/revision-dependencies';
import {duplicateProject,type DuplicateCommand} from '../../project/duplicate';
import type {DatabasePool} from './database-pool';
import {applySelfHostedMigrations} from './schema';
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { FolderProject } from "../../project/package";
import type { ProjectRepository } from "../../project/repository";
import { validateDoc, validateReferences, initialState, type DeckDoc } from "../../domain/model";
import { canonicalJson } from "../../domain/canonical-json";
import {exportId,exportKey,exportSummary,type ExportManifest} from '../../project/export-artifact';
import {verifyExportManifest,verifyExportBytes} from '../../project/verify-export';
import {catalogInfo,catalogFolders,catalogReceipt,mutateFolder,resolveMaterialId,checkCatalogFolder} from './catalog';

export const fingerprint = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export type DbTx = PoolClient;

/** Local owner-scoped boundary. Inference and export I/O stay outside transactions; bounded layout validation is synchronous. */
export class ChatDatabase {
  readonly pool: DatabasePool;
  constructor(readonly options: {connection: PoolConfig; tenantId: string; ownerId: string; runtimeRoot: string; runtimeMode?:'configured'|'dedicated'}, private execution?: {pool:DatabasePool;run<T>(fn:(c:DbTx)=>Promise<T>):Promise<T>}) {
    if(execution)this.pool=execution.pool;
    else {const pool=new Pool({...options.connection, max:5, connectionTimeoutMillis:5000});pool.on("error",()=>{});this.pool=pool;}
  }
  get tenant() {return this.options.tenantId;}
  get owner() {return this.options.ownerId;}
  catalogInfo(){return catalogInfo(this);}
  catalogFolders(){return catalogFolders(this);}
  catalogReceipt(requestId:string,command:unknown){return catalogReceipt(this,requestId,command);}
  mutateFolder(requestId:string,command:unknown){return mutateFolder(this,requestId,command);}
  resolveMaterialId(id:string){return resolveMaterialId(this,id);}
  async init() {
    if(this.execution)throw Error("A transaction view cannot initialize storage.");
    await mkdir(this.options.runtimeRoot, {recursive: true, mode: 0o700});
    await applySelfHostedMigrations(this.pool);
    await this.tx(async c => {
      await c.query("INSERT INTO lanka.agent_connections(tenant_id,owner_id,id,runtime_mode) VALUES($1,$2,'local-codex',$3) ON CONFLICT DO NOTHING", [this.tenant,this.owner,this.options.runtimeMode||'configured']);
    });
  }
  async tx<T>(fn: (c: DbTx) => Promise<T>): Promise<T> {
    if(this.execution)return this.execution.run(fn);
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      // Single-owner local writes use one short lock. Never held during inference.
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [this.tenant+":"+this.owner]);
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch(e) {await c.query("ROLLBACK").catch(() => {}); throw e;}
    finally {c.release();}
  }
  async project(c: DbTx | DatabasePool, id: string, lock = false): Promise<FolderProject> {
    const r = await c.query("SELECT project FROM lanka.materials WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 AND NOT trashed"+(lock?" FOR UPDATE":""), [this.tenant,this.owner,id]);
    if(!r.rows[0])throw new Error("Документ недоступен.");
    const p=r.rows[0].project as FolderProject;
    p.state.doc=validateDoc(p.state.doc); validateReferences(p.state);
    return p;
  }
  async owns(id: string) {
    if(!/^[a-f0-9-]{36}$/i.test(id))return false;
    const r=await this.pool.query("SELECT 1 FROM lanka.materials WHERE tenant_id=$1 AND owner_id=$2 AND id=$3",[this.tenant,this.owner,id]);
    return !!r.rowCount;
  }
  repository(id: string) {return new PostgresProjectRepository(this,id);}
  async receipt(c: DbTx, id: string, materialId: string, payload: unknown) {
    const r=await c.query("SELECT fingerprint,result,material_id FROM lanka.command_receipts WHERE tenant_id=$1 AND owner_id=$2 AND request_id=$3",[this.tenant,this.owner,id]);
    if(!r.rows[0]){
      const imported=await c.query('SELECT material_id,source_hash,result FROM lanka.imported_project_receipts WHERE tenant_id=$1 AND owner_id=$2 AND request_id=$3',[this.tenant,this.owner,id]);
      if(!imported.rowCount)return null;
      if(imported.rows[0].material_id!==materialId||imported.rows[0].source_hash!==createHash('sha256').update(JSON.stringify(payload)).digest('hex'))throw Error('Ключ повтора уже использован для другого действия.');
      return {result:imported.rows[0].result};
    }
    if(r.rows[0].fingerprint!==fingerprint(payload)||r.rows[0].material_id!==materialId)throw new Error("Ключ повтора уже использован для другого действия.");
    return {result:r.rows[0].result};
  }
  async remember(c: DbTx, id: string, materialId: string, payload: unknown, result: unknown) {
    await c.query("INSERT INTO lanka.command_receipts(tenant_id,owner_id,request_id,material_id,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6)",[this.tenant,this.owner,id,materialId,fingerprint(payload),JSON.stringify(result)]);
  }
  async saveProject(c: DbTx, id: string, p: FolderProject, label: string, designSourceRevision?:number) {
    p.state.doc=validateDoc(p.state.doc); validateReferences(p.state);
    if(p.state.doc.id!==id)throw new Error("Нельзя подменить документ.");
    const bytes=JSON.stringify(p.state.doc), hash=fingerprint(p.state.doc);
    const inserted=await c.query("INSERT INTO lanka.material_revisions(tenant_id,material_id,revision,hash,doc,action) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING revision",[this.tenant,id,p.state.revision,hash,bytes,label]);
    if(!inserted.rowCount) {
      const r=await c.query("SELECT hash FROM lanka.material_revisions WHERE tenant_id=$1 AND material_id=$2 AND revision=$3",[this.tenant,id,p.state.revision]);
      if(r.rows[0]?.hash!==hash)throw new Error("Содержимое версии неизменяемо.");
    }
    if(inserted.rowCount){
      const source=await c.query(`SELECT binding.package_digest FROM lanka.materials m
        JOIN lanka.revision_design_packages binding ON binding.tenant_id=m.tenant_id AND binding.material_id=m.id
        AND binding.revision=coalesce($3::integer,(m.project#>>'{state,revision}')::integer)
        WHERE m.tenant_id=$1 AND m.id=$2`,[this.tenant,id,designSourceRevision??null]);
      if(source.rowCount)await bindRevisionDesignIn(c,this.tenant,{documentId:id,revision:p.state.revision,documentHash:hash},source.rows[0].package_digest);
      const captured=await captureRevisionDependencies(p,async sha256=>(await c.query('SELECT bytes FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2 AND key=$3 FOR SHARE',[this.tenant,id,`materials/${sha256}.bin`])).rows[0]?.bytes);
      for(const blob of captured.blobs)await c.query('INSERT INTO lanka.revision_dependency_blobs(tenant_id,material_id,hash,bytes) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[this.tenant,id,blob.hash,blob.bytes]);
      await c.query('INSERT INTO lanka.revision_dependency_snapshots(tenant_id,material_id,revision,document_hash,payload,bytes,hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[this.tenant,id,p.state.revision,hash,JSON.stringify(captured.snapshot),captured.bytes,captured.hash]);
    }
    const history=await c.query("SELECT revision,hash,action,created_at FROM lanka.material_revisions WHERE tenant_id=$1 AND material_id=$2 ORDER BY revision",[this.tenant,id]);
    p.history=history.rows.map(r=>({revision:r.revision,hash:r.hash,action:r.action,createdAt:r.created_at.toISOString()}));
    p.receipts=[]; // Receipts are atomic rows, not an ever-growing document field.
    if(Buffer.byteLength(JSON.stringify(p))>1_500_000)throw new Error("Документ превышает допустимый размер.");
    await c.query("UPDATE lanka.materials SET project=$4,version=version+1,updated_at=now() WHERE tenant_id=$1 AND owner_id=$2 AND id=$3",[this.tenant,this.owner,id,JSON.stringify(p)]);
  }
  async duplicateIn(c:DbTx,requestId:string,cmd:DuplicateCommand,sourceId=cmd.id){
    const prior=await this.receipt(c,requestId,requestId,cmd);if(prior)return prior.result;
    const row=await c.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 AND trashed=false FOR UPDATE',[this.tenant,this.owner,sourceId]);
    if(!row.rows[0])throw Error('Документ недоступен.');
    const project=duplicateProject(row.rows[0].project,requestId,cmd.title,cmd.expectedRevision),blobs:{hash:string;bytes:Buffer}[]=[];let total=0;
    for(const source of project.state.sources){
      const blob=await c.query('SELECT bytes FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2 AND key=$3',[this.tenant,sourceId,`materials/${source.sha256}.bin`]);
      const bytes=blob.rows[0]?.bytes as Buffer|undefined;
      if(!bytes||bytes.length>5_000_000||(total+=bytes.length)>40_000_000)throw Error('Источник недоступен или материалы превышают лимит.');
      blobs.push({hash:source.sha256,bytes});
    }
    return this.createProjectIn(c,requestId,project,cmd.folderId,blobs,cmd,{id:requestId,revision:1});
  }
  async create(requestId: string, doc: DeckDoc, folderId: string|null = null, sources: FolderProject["state"]["sources"] = [], blobs: {hash:string;bytes:Buffer}[] = [], payload: unknown = {action:"create",doc,folderId}) {
    return this.tx(c=>this.createIn(c,requestId,doc,folderId,sources,blobs,payload));
  }
  async createIn(c: DbTx, requestId: string, doc: DeckDoc, folderId: string|null, sources: FolderProject["state"]["sources"], blobs: {hash:string;bytes:Buffer}[], payload: unknown) {
      const state=initialState(validateDoc(doc)); state.sources=sources;
      const p:FolderProject={format:"lanka-project/v1",title:doc.title,state,receipts:[]};
      return this.createProjectIn(c,requestId,p,folderId,blobs,payload,{id:doc.id,revision:1});
  }
  async createProjectIn(c:DbTx,requestId:string,p:FolderProject,folderId:string|null,blobs:{hash:string;bytes:Buffer}[],payload:unknown,result:unknown) {
      const doc=validateDoc(p.state.doc);
      const old=await this.receipt(c,requestId,doc.id,payload);if(old)return old.result;
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[this.tenant+':material-ids']);
      const alias=await c.query('SELECT 1 FROM lanka.material_aliases WHERE tenant_id=$1 AND alias_id=$2 LIMIT 1',[this.tenant,doc.id]);if(alias.rowCount)throw Error('ID документа уже закреплён за старой ссылкой.');
      if(p.state.revision!==1||p.state.approvedRevision!==null||p.state.grants.length)throw new Error("Новый документ должен быть частным черновиком первой версии.");
      validateReferences(p.state);
      await checkCatalogFolder(this,c,folderId);
      await c.query("INSERT INTO lanka.materials(tenant_id,id,owner_id,project,folder_id) VALUES($1,$2,$3,$4,$5)",[this.tenant,doc.id,this.owner,JSON.stringify(p),folderId]);
      for(const b of blobs) {
        if(createHash("sha256").update(b.bytes).digest("hex")!==b.hash)throw new Error("Файл источника изменился.");
        await c.query("INSERT INTO lanka.blobs(tenant_id,material_id,key,bytes) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",[this.tenant,doc.id,`materials/${b.hash}.bin`,b.bytes]);
      }
      await this.saveProject(c,doc.id,p,"Создан документ");
      await this.remember(c,requestId,doc.id,payload,result); return result;
  }
  async listing() {
    const r=await this.pool.query("SELECT id,folder_id,trashed,created_at,updated_at,project FROM lanka.materials WHERE tenant_id=$1 AND owner_id=$2 ORDER BY updated_at DESC LIMIT 500",[this.tenant,this.owner]);
    return r.rows.map(r=>{const p=r.project as FolderProject;return {id:r.id,title:p.title,folderId:r.folder_id,trashed:r.trashed,createdAt:r.created_at.toISOString(),updatedAt:r.updated_at.toISOString(),revision:p.state.revision,slideCount:p.state.doc.slides.length,design:p.state.doc.design,preview:{slide:p.state.doc.slides[0],brand:p.state.doc.brand},pending:p.state.proposals.filter(p=>p.status==="pending").length,chat:true};});
  }
  async catalogCommand(requestId: string, id: string, command: {action:string; folderId?:string|null;trashed?:boolean}) {
    return this.tx(async c=>{
      const prior=await this.receipt(c,requestId,id,command); if(prior)return prior.result;
      const r=await c.query("SELECT id FROM lanka.materials WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE",[this.tenant,this.owner,id]);
      if(!r.rowCount)throw new Error("Документ недоступен.");
      if(command.action==="move_document"){await checkCatalogFolder(this,c,command.folderId??null);await c.query("UPDATE lanka.materials SET folder_id=$4 WHERE tenant_id=$1 AND owner_id=$2 AND id=$3",[this.tenant,this.owner,id,command.folderId]);}
      else if(command.action==="trash_document") {
        await c.query("UPDATE lanka.materials SET trashed=$4 WHERE tenant_id=$1 AND owner_id=$2 AND id=$3",[this.tenant,this.owner,id,command.trashed]);
        if(command.trashed) {
          const runs=await c.query("SELECT j.id,j.session_id,r.assistant_message_id FROM lanka.jobs j JOIN lanka.agent_runs r ON r.tenant_id=j.tenant_id AND r.id=j.id JOIN lanka.agent_sessions s ON s.tenant_id=j.tenant_id AND s.id=j.session_id WHERE j.tenant_id=$1 AND s.owner_id=$2 AND s.material_id=$3 AND j.status IN ('queued','running','unknown')",[this.tenant,this.owner,id]);
          await c.query("UPDATE lanka.jobs SET status='cancelled',fence=fence+1,lease_until=NULL WHERE tenant_id=$1 AND session_id IN (SELECT id FROM lanka.agent_sessions WHERE tenant_id=$1 AND owner_id=$2 AND material_id=$3) AND status IN ('queued','running','unknown')",[this.tenant,this.owner,id]);
          for(const run of runs.rows) {
            await c.query("UPDATE lanka.agent_messages SET status='interrupted',text=CASE WHEN text='' THEN 'Поручение остановлено при удалении документа.' ELSE text END WHERE tenant_id=$1 AND id=$2",[this.tenant,run.assistant_message_id]);
            await this.event(c,run.session_id,run.id,"run.cancelled",{reason:"material_trashed"});
          }
          await c.query("UPDATE lanka.agent_sessions SET context_epoch=context_epoch+1,native_thread_id=NULL,native_context_epoch=NULL WHERE tenant_id=$1 AND owner_id=$2 AND material_id=$3",[this.tenant,this.owner,id]);
        }
      } else throw new Error("Неизвестное действие.");
      const result={ok:true};await this.remember(c,requestId,id,command,result); return result;
    });
  }
  async ensureSession(materialId: string) {
    materialId=await this.resolveMaterialId(materialId);
    return this.tx(c=>this.ensureSessionIn(c,materialId));
  }
  async ensureSessionIn(c: DbTx, materialId: string) {
    await this.project(c,materialId);
    await c.query("INSERT INTO lanka.agent_sessions(tenant_id,id,material_id,owner_id) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,material_id,owner_id) DO NOTHING",[this.tenant,randomUUID(),materialId,this.owner]);
    const r=await c.query("SELECT id FROM lanka.agent_sessions WHERE tenant_id=$1 AND owner_id=$2 AND material_id=$3",[this.tenant,this.owner,materialId]);return r.rows[0].id as string;
  }
  async session(c: DbTx | DatabasePool, id: string) {
    const r=await c.query("SELECT s.* FROM lanka.agent_sessions s JOIN lanka.materials m ON m.tenant_id=s.tenant_id AND m.id=s.material_id WHERE s.tenant_id=$1 AND s.owner_id=$2 AND s.id=$3 AND NOT m.trashed",[this.tenant,this.owner,id]);
    if(!r.rows[0])throw new Error("Беседа недоступна."); return r.rows[0];
  }
  async event(c: DbTx, sessionId:string, runId:string|null,kind:string,payload:unknown) {
    const r=await c.query("UPDATE lanka.agent_sessions SET next_event_seq=next_event_seq+1,updated_at=now() WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 RETURNING next_event_seq",[this.tenant,this.owner,sessionId]);
    if(!r.rowCount)throw new Error("Беседа недоступна.");
    const sequence=Number(r.rows[0].next_event_seq);
    await c.query("INSERT INTO lanka.agent_events(tenant_id,session_id,sequence,run_id,kind,payload) VALUES($1,$2,$3,$4,$5,$6)",[this.tenant,sessionId,sequence,runId,kind,JSON.stringify(payload)]);return sequence;
  }
  async close() {await this.pool.end();}
}

export class PostgresProjectRepository implements ProjectRepository {
  private mutation=new AsyncLocalStorage<{c:DbTx;files:Map<string,Buffer>;designSourceRevision?:number}>();
  readonly root:string;
  constructor(readonly db:ChatDatabase,readonly id:string) {this.root=resolve(db.options.runtimeRoot,id);}
  async read() {return this.db.project(this.db.pool,this.id);}
  async mutate(requestId:string,payload:unknown,change:(old:FolderProject|null)=>Promise<{project:FolderProject;result:unknown}>) {
    return this.db.tx(async c=>{
      const p=await this.db.project(c,this.id,true);
      const prior=await this.db.receipt(c,requestId,this.id,payload);if(prior)return prior.result;
      const context:{c:DbTx;files:Map<string,Buffer>;designSourceRevision?:number}={c,files:new Map<string,Buffer>()};
      const {project,result}=await this.mutation.run(context,()=>change(p));
      for(const [hash,bytes] of context.files)await c.query("INSERT INTO lanka.blobs(tenant_id,material_id,key,bytes) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",[this.db.tenant,this.id,`materials/${hash}.bin`,bytes]);
      const action=(payload as {command?:{action?:string}}).command?.action;
      await this.db.saveProject(c,this.id,project,action==="accept"?"Приняты изменения":action==="restore"?"Восстановление версии":"Сохранены правки",context.designSourceRevision);
      await this.db.remember(c,requestId,this.id,payload,result);return result;
    });
  }
  async restoreRevision(revision:number){
    const current=this.mutation.getStore();if(!current)throw Error('Восстановление доступно только внутри операции документа.');
    const restored=await loadRestorableRevisionIn(current.c,this.db.tenant,this.id,revision);
    current.designSourceRevision=revision;
    for(const [hash,bytes] of restored.files)current.files.set(hash,bytes);
    return {doc:restored.doc,sources:restored.sources};
  }
  readRevisionSources(revision:number){
    return this.db.tx(async c=>{
      await this.db.project(c,this.id);
      const row=await c.query('SELECT 1 FROM lanka.revision_dependency_snapshots WHERE tenant_id=$1 AND material_id=$2 AND revision=$3',[this.db.tenant,this.id,revision]);
      if(!row.rowCount)return null;
      const archive=await readRevisionDependenciesIn(c,this.db.tenant,this.id,revision);
      return {sources:archive.project.state.sources,unavailable:archive.snapshot.unavailable};
    });
  }
  readRevisionAsset(revision:number,id:string){
    return this.db.tx(async c=>{await this.db.project(c,this.id);return readRevisionAssetIn(c,this.db.tenant,this.id,revision,id);});
  }
  async readSnapshot(hash:string) {
    await this.read();
    const r=await this.db.pool.query("SELECT doc,hash,source_hash FROM lanka.material_revisions WHERE tenant_id=$1 AND material_id=$2 AND (hash=$3 OR source_hash=$3) LIMIT 1",[this.db.tenant,this.id,hash]);
    if(!r.rows[0]||fingerprint(r.rows[0].doc)!==r.rows[0].hash)throw new Error("Версия недоступна или повреждена.");
    return validateDoc(r.rows[0].doc);
  }
  async readFile(key:string,max=5_000_000):Promise<Buffer> {
    await this.read();
    if(!/^materials\/[a-f0-9]{64}\.bin$/.test(key))throw new Error("Файл находится вне документа.");
    const r=await this.db.pool.query("SELECT bytes FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2 AND key=$3",[this.db.tenant,this.id,key]);
    if(!r.rows[0]||r.rows[0].bytes.length>max)throw new Error("Файл недоступен или превышает лимит.");return r.rows[0].bytes;
  }
  async writeExport(name:"presentation.pptx"|"presentation.pdf"|"lanka-handoff.json",bytes:Uint8Array) {
    await this.read();
    if(bytes.length>40_000_000)throw new Error("Экспорт превышает лимит.");
    const key=`exports/${randomUUID()}/${name}`;
    await this.db.pool.query("INSERT INTO lanka.blobs(tenant_id,material_id,key,bytes) VALUES($1,$2,$3,$4)",[this.db.tenant,this.id,key,Buffer.from(bytes)]);return key;
  }
  async saveExportArtifact(value:ExportManifest,bytes:Uint8Array){
    const m=verifyExportManifest(value,this.id);verifyExportBytes(m,bytes);
    return this.db.tx(async c=>{
      await this.db.project(c,this.id,true);
      const revision=await c.query('SELECT hash FROM lanka.material_revisions WHERE tenant_id=$1 AND material_id=$2 AND revision=$3',[this.db.tenant,this.id,m.revision]);
      if(revision.rows[0]?.hash!==m.documentHash)throw Error('Исходная версия экспорта недоступна.');
      await c.query('INSERT INTO lanka.export_artifacts(tenant_id,material_id,id,created_at,manifest,bytes) VALUES($1,$2,$3,$4,$5,$6)',[this.db.tenant,this.id,m.id,m.createdAt,JSON.stringify(m),Buffer.from(bytes)]);
      return exportKey(m.id,`presentation.${m.output.format}`);
    });
  }
  async listExportArtifacts(cursor?:string){
    await this.read();if(cursor)exportId(cursor);
    const args:unknown[]=[this.db.tenant,this.id];let after='';
    if(cursor){args.push(cursor);after=' AND (created_at,id) < (SELECT created_at,id FROM lanka.export_artifacts WHERE tenant_id=$1 AND material_id=$2 AND id=$3)';}
    const r=await this.db.pool.query('SELECT id,manifest FROM lanka.export_artifacts WHERE tenant_id=$1 AND material_id=$2'+after+' ORDER BY created_at DESC,id DESC LIMIT 26',args);
    const items=r.rows.slice(0,25).map(r=>exportSummary(verifyExportManifest(r.manifest,this.id,r.id)));
    return {items,nextCursor:r.rows.length>25?items.at(-1)!.id:null};
  }
  async readExportManifest(id:string){
    await this.read();exportId(id);
    const r=await this.db.pool.query('SELECT manifest FROM lanka.export_artifacts WHERE tenant_id=$1 AND material_id=$2 AND id=$3',[this.db.tenant,this.id,id]);
    if(!r.rows[0])throw Error('Экспорт недоступен.');return verifyExportManifest(r.rows[0].manifest,this.id,id);
  }
  async readExportArtifact(id:string){
    await this.read();exportId(id);
    const r=await this.db.pool.query('SELECT manifest,bytes FROM lanka.export_artifacts WHERE tenant_id=$1 AND material_id=$2 AND id=$3',[this.db.tenant,this.id,id]);
    if(!r.rows[0])throw Error('Экспорт недоступен.');
    const m=verifyExportManifest(r.rows[0].manifest,this.id,id);verifyExportBytes(m,r.rows[0].bytes);return r.rows[0].bytes as Buffer;
  }
  async readExport(key:string):Promise<Buffer> {
    await this.read();
    if(!/^exports\/[a-f0-9-]{36}\/(presentation\.(pdf|pptx)|lanka-handoff\.json)$/.test(key))throw new Error("Экспорт недоступен.");
    const id=key.split('/')[1];
    const artifact=await this.db.pool.query('SELECT manifest,bytes FROM lanka.export_artifacts WHERE tenant_id=$1 AND material_id=$2 AND id=$3',[this.db.tenant,this.id,id]);
    if(artifact.rows[0]){const m=verifyExportManifest(artifact.rows[0].manifest,this.id,id);if(key!==exportKey(id,`presentation.${m.output.format}`))throw Error('Экспорт недоступен.');verifyExportBytes(m,artifact.rows[0].bytes);return artifact.rows[0].bytes;}
    const r=await this.db.pool.query("SELECT bytes FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2 AND key=$3",[this.db.tenant,this.id,key]);
    if(!r.rows[0])throw new Error("Экспорт недоступен.");return r.rows[0].bytes;
  }
}
