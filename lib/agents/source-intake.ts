import {changedContent} from '../domain/model';
import {canPopulateDraft} from '../project/empty-draft';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ChatDatabase,fingerprint,type DbTx} from '../adapters/postgres/chat-database';
import {sourceExtractionSchema,type SourceExtraction,type SourceIntakeView} from '../domain/source-extraction';
import {withSourceExtractionSlot} from '../adapters/postgres/source-extraction-slot';
import type {FolderProject} from '../project/package';

const uploadSchema=z.object({requestId:z.string().uuid(),name:z.string().trim().min(1).max(140).refine(n=>!/[\x00-\x1f/\\]/.test(n)),base64:z.string().min(4).max(6_666_668)}).strict();
const types:Record<string,string>={'.pdf':'application/pdf','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.json':'application/json'};
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const exec=promisify(execFile);
const parserPath=resolve(import.meta.dirname,'../runtime/extract.py');
const resultSchema=sourceExtractionSchema.omit({parser:true});

/** Limited local subprocess, not a corporate sandbox. It receives no application credentials. */
export async function extractSource(bytes:Buffer,name:string,signal?:AbortSignal):Promise<SourceExtraction> {
  const parser={name:'lanka-source' as const,version:1 as const,sha256:hash(Buffer.concat([await readFile(parserPath),Buffer.from('creation-excerpt-v1:12000-with-locators')]))};
  const directory=await mkdtemp(join(tmpdir(),'lanka-source-'));
  try {
    const path=join(directory,'input');await writeFile(path,bytes,{mode:0o600});
    let result:z.infer<typeof resultSchema>;
    try {
      const {stdout}=await exec(process.env.LANKA_PYTHON||(process.platform==='darwin'?'/usr/bin/python3':'python3'),[parserPath,path,name],{cwd:directory,timeout:25000,maxBuffer:800000,signal,env:{NODE_ENV:'production',PATH:process.env.PATH||'/usr/bin:/bin',LANG:'en_US.UTF-8',PYTHONIOENCODING:'utf-8'}});
      result=resultSchema.parse(JSON.parse(stdout));
    } catch {result={status:'failed',note:'Не удалось прочитать файл. Проверьте Python, XML и pdftotext на сервере или вставьте текст вручную.',fragments:[]};}
    let remaining=12000,truncated=false;
    const fragments:SourceExtraction['fragments']=[];
    for(const fragment of result.fragments){
      const overhead=fragment.locator.length+5,available=Math.max(0,remaining-overhead);
      if(!available){truncated=true;continue;}
      const text=fragment.text.slice(0,available);
      truncated ||= text.length<fragment.text.length;
      if(text){fragments.push({...fragment,text});remaining-=text.length+overhead;}
    }
    if(truncated){result.status='partial';result.note='Для создания доступны первые 12 000 знаков с указателями. Остальной текст не передаётся агенту. '+result.note;}
    if(!fragments.length&&['partial','extracted'].includes(result.status))result={status:'failed',note:'Читаемый текст не найден. Для скана нужен OCR; можно вставить текст вручную.',fragments:[]};
    return sourceExtractionSchema.parse({...result,fragments,parser});
  } finally {await rm(directory,{recursive:true,force:true});}
}
/** A server-supplied scope binds temporary uploads to one delegation without exposing older owner uploads. */
export type SourceIntakeScope={delegationHash:string};
const intakeFingerprint=(name:string,sha256:string,scope?:SourceIntakeScope)=>fingerprint({name,sha256,...(scope?{delegationHash:scope.delegationHash}:{})});
async function inScope(db:ChatDatabase,c:DbTx,row:any,scope?:SourceIntakeScope){
 if(!scope||row.fingerprint===intakeFingerprint(row.name,row.sha256,scope))return true;
 const grant=await c.query(`SELECT 1 FROM lanka.agent_source_grants g JOIN lanka.agent_delegations d ON d.tenant_id=g.tenant_id AND d.id=g.delegation_id
 WHERE g.tenant_id=$1 AND g.owner_id=$2 AND g.source_id=$3 AND g.sha256=$4 AND d.token_hash=$5
 AND d.issuer_id=g.owner_id AND d.scope_kind='workspace' AND 'create'=ANY(d.capabilities) AND d.revoked_at IS NULL AND d.expires_at>now()`,[db.tenant,db.owner,row.id,row.sha256,scope.delegationHash]);return !!grant.rowCount;
}
function view(row:any):SourceIntakeView{return {id:row.id,name:row.name,sha256:row.sha256,size:Number(row.byte_size??row.bytes.length),createdAt:row.created_at.toISOString(),expiresAt:row.expires_at.toISOString(),extraction:sourceExtractionSchema.parse(row.extraction)};}
export async function listSourceIntakes(db:ChatDatabase,scope?:SourceIntakeScope){return db.tx(async c=>{
 const rows=(await c.query('SELECT id,name,sha256,fingerprint,octet_length(bytes) AS byte_size,created_at,expires_at,extraction FROM lanka.source_intakes WHERE tenant_id=$1 AND owner_id=$2 AND expires_at>now() ORDER BY created_at DESC LIMIT 30',[db.tenant,db.owner])).rows;
 const visible=[];for(const row of rows)if(await inScope(db,c,row,scope))visible.push(view(row));return visible;
});}
export async function readSourceIntake(db:ChatDatabase,c:DbTx,id:string,scope?:SourceIntakeScope){
  const r=await c.query('SELECT * FROM lanka.source_intakes WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 AND expires_at>now()',[db.tenant,db.owner,id]);
  if(!r.rows[0]||!await inScope(db,c,r.rows[0],scope))throw Error('Файл недоступен или срок хранения истёк. Загрузите его снова.');
  r.rows[0].extraction=sourceExtractionSchema.parse(r.rows[0].extraction);
  return r.rows[0];
}
export async function getSourceIntake(db:ChatDatabase,id:string,scope?:SourceIntakeScope){return db.tx(async c=>view(await readSourceIntake(db,c,z.string().uuid().parse(id),scope)));}
export async function sourceContent(db:ChatDatabase,c:DbTx,id:string,scope?:SourceIntakeScope){
  const row=await readSourceIntake(db,c,id,scope);
  if(!['extracted','partial'].includes(row.extraction.status)||!row.extraction.fragments.length)throw Error('В файле нет доступного текста. Загрузите другой файл или вставьте текст.');
  if(hash(row.bytes)!==row.sha256)throw Error('Контрольная сумма исходного файла не совпала.');
  const source:FolderProject['state']['sources'][number]={id:row.id,name:row.name,kind:'document',sha256:row.sha256,createdAt:row.created_at.toISOString(),contentType:row.content_type,excerpt:row.extraction.fragments.map((f:{locator:string;text:string})=>`[${f.locator}] ${f.text}`).join('\n\n'),extraction:row.extraction};
  return {source,bytes:row.bytes as Buffer};
}
/** Called inside the same owner transaction that creates the draft and its receipt. */
export async function adoptSourceIntake(db:ChatDatabase,c:DbTx,id:string,draft:FolderProject,blobs:{hash:string;bytes:Buffer}[]){
  if(!draft.draftShell)throw Error('Источник можно подключить только к новой заготовке.');
  const {source,bytes}=await sourceContent(db,c,id);draft.state.sources.push(source);blobs.push({hash:source.sha256,bytes});
  draft.draftShell.sourceHash=fingerprint(draft.state.sources);
}
export const attachSourceInput=z.object({requestId:z.string().uuid(),expectedRevision:z.number().int().positive(),sourceIntakeId:z.string().uuid()}).strict();
export async function attachSourceIntake(db:ChatDatabase,documentId:string,input:unknown){
  z.string().uuid().parse(documentId);const a=attachSourceInput.parse(input);
  return db.tx(async c=>{
    const row=await c.query('SELECT project FROM lanka.materials WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 AND trashed=false FOR UPDATE',[db.tenant,db.owner,documentId]);
    if(!row.rows[0])throw Error('Документ недоступен.');
    const payload={action:'attach_source_intake',...a},prior=await db.receipt(c,a.requestId,documentId,payload);if(prior)return prior.result;
    const p=row.rows[0].project as FolderProject;
    if(p.state.revision!==a.expectedRevision)throw Error('Конфликт версии. Обновите документ перед прикреплением.');
    const active=await c.query("SELECT 1 FROM lanka.jobs j JOIN lanka.agent_sessions s ON s.tenant_id=j.tenant_id AND s.id=j.session_id WHERE s.tenant_id=$1 AND s.material_id=$2 AND j.status IN ('queued','running','unknown') LIMIT 1",[db.tenant,documentId]);
    if(active.rowCount)throw Error('Дождитесь завершения или остановите поручение агента перед прикреплением файла.');
    const {source,bytes}=await sourceContent(db,c,a.sourceIntakeId),existing=p.state.sources.find(s=>s.id===source.id);
    if(existing&&fingerprint(existing)!==fingerprint(source))throw Error('Источник с таким ID уже существует.');
    if(!existing){
      const total=await c.query("SELECT coalesce(sum(octet_length(bytes)),0)::bigint AS size FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2 AND key LIKE 'materials/%'",[db.tenant,documentId]);
      if(Number(total.rows[0].size)+bytes.length>40_000_000)throw Error('Материалы презентации превышают 40 МБ.');
      const pristine=canPopulateDraft(p);p.state.sources.push(source);changedContent(p.state);
      if(pristine&&p.draftShell){p.draftShell.revision=p.state.revision;p.draftShell.sourceHash=fingerprint(p.state.sources);}
      const stored=await c.query('SELECT bytes FROM lanka.blobs WHERE tenant_id=$1 AND material_id=$2 AND key=$3',[db.tenant,documentId,`materials/${source.sha256}.bin`]);
      if(stored.rows[0]&&hash(stored.rows[0].bytes)!==source.sha256)throw Error('Контрольная сумма сохранённого источника не совпала.');
      await c.query('INSERT INTO lanka.blobs(tenant_id,material_id,key,bytes) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[db.tenant,documentId,`materials/${source.sha256}.bin`,bytes]);
      await db.saveProject(c,documentId,p,'Прикреплён источник');
    }
    const result={sourceId:source.id,revision:p.state.revision};await db.remember(c,a.requestId,documentId,payload,result);return result;
  });
}
/** Retire an upload ID before removing bytes and grants. Original document copies are untouched. */
export async function removeSourceIntake(db:ChatDatabase,id:string,sha256:string){
 z.string().uuid().parse(id);z.string().regex(/^[a-f0-9]{64}$/).parse(sha256);
 return db.tx(async c=>{
  const prior=await c.query('SELECT sha256 FROM lanka.source_intake_deletions WHERE tenant_id=$1 AND owner_id=$2 AND id=$3',[db.tenant,db.owner,id]);
  if(prior.rowCount){if(prior.rows[0].sha256!==sha256)throw Error('Материал изменился. Обновите список перед удалением.');return {removed:true};}
  const r=await c.query('SELECT sha256 FROM lanka.source_intakes WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE',[db.tenant,db.owner,id]);
  if(!r.rowCount)return {removed:true};
  if(r.rows[0].sha256!==sha256)throw Error('Материал изменился. Обновите список перед удалением.');
  await c.query('INSERT INTO lanka.source_intake_deletions(tenant_id,owner_id,id,sha256) VALUES($1,$2,$3,$4)',[db.tenant,db.owner,id,sha256]);
  await c.query('DELETE FROM lanka.source_intakes WHERE tenant_id=$1 AND owner_id=$2 AND id=$3',[db.tenant,db.owner,id]);return {removed:true};
 });
}
async function assertIntakeNotDeleted(db:ChatDatabase,c:DbTx,id:string){if((await c.query('SELECT 1 FROM lanka.source_intake_deletions WHERE tenant_id=$1 AND owner_id=$2 AND id=$3',[db.tenant,db.owner,id])).rowCount)throw Error('Материал удалён из подготовки. Для новой загрузки используйте новый запрос.');}
export async function stageSourceIntake(db:ChatDatabase,input:unknown,extract=extractSource,scope?:SourceIntakeScope){
  const a=uploadSchema.parse(input),ext=extname(a.name).toLowerCase();
  if(!types[ext])throw Error('Поддерживаются PDF, DOCX, PPTX, XLSX, TXT, MD, CSV и JSON.');
  const bytes=Buffer.from(a.base64,'base64');
  if(!bytes.length||bytes.length>5_000_000||bytes.toString('base64')!==a.base64)throw Error('Файл повреждён или превышает 5 МБ.');
  if(['.txt','.md','.csv','.json'].includes(ext)&&bytes.length>200000)throw Error('Текстовый файл превышает 200 КБ.');
  const sha256=hash(bytes),key=intakeFingerprint(a.name,sha256,scope);
  const previous=await db.tx(async c=>{
    await assertIntakeNotDeleted(db,c,a.requestId);
    await c.query('DELETE FROM lanka.source_intakes WHERE tenant_id=$1 AND owner_id=$2 AND expires_at<=now()',[db.tenant,db.owner]);
    const r=await c.query('SELECT * FROM lanka.source_intakes WHERE tenant_id=$1 AND owner_id=$2 AND id=$3',[db.tenant,db.owner,a.requestId]);
    if(r.rows[0]&&r.rows[0].fingerprint!==key)throw Error('Ключ загрузки уже использован для другого файла.');
    return r.rows[0];
  });
  if(previous)return view(previous);
  const extraction=sourceExtractionSchema.parse(await withSourceExtractionSlot(db,signal=>extract(bytes,a.name,signal)));
  return db.tx(async c=>{
    await assertIntakeNotDeleted(db,c,a.requestId);
    const existing=await c.query('SELECT * FROM lanka.source_intakes WHERE tenant_id=$1 AND owner_id=$2 AND id=$3',[db.tenant,db.owner,a.requestId]);
    if(existing.rows[0]){if(existing.rows[0].fingerprint!==key)throw Error('Ключ загрузки уже использован для другого файла.');return view(existing.rows[0]);}
    const quota=await c.query('SELECT count(*)::int AS count,coalesce(sum(octet_length(bytes)),0)::int AS size FROM lanka.source_intakes WHERE tenant_id=$1 AND owner_id=$2',[db.tenant,db.owner]);
    if(quota.rows[0].count>=30||quota.rows[0].size+bytes.length>50_000_000)throw Error('Достигнут лимит временных файлов: 30 файлов или 50 МБ. Удалите ненужный файл.');
    const r=await c.query('INSERT INTO lanka.source_intakes(tenant_id,owner_id,id,fingerprint,name,content_type,sha256,bytes,extraction) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[db.tenant,db.owner,a.requestId,key,a.name,types[ext],sha256,bytes,JSON.stringify(extraction)]);
    return view(r.rows[0]);
  });
}
