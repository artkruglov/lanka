import {loadRestorableRevisionIn} from './revision-dependencies';
import { createHash } from "node:crypto";
import { ChatDatabase, PostgresProjectRepository, type DbTx } from "./chat-database";
import type { FolderProject } from "../../project/package";
import type { ProjectRepository } from "../../project/repository";
import type {ExportManifest} from '../../project/export-artifact';
export type McpMutationGuard={
  readonly receiptScope:unknown;
  before(c:DbTx,payload:unknown):Promise<void>;
  after(c:DbTx,before:FolderProject|null,after:FolderProject,result:unknown,payload:unknown):Promise<void>;
};

/** A local stdio process is bound to one document by its launch arguments. */
export class PostgresMcpRepository implements ProjectRepository {
  private base:PostgresProjectRepository;
  private pending:Map<string,Buffer>|null=null;
  private mutationClient:DbTx|null=null;
  private designSourceRevision:number|undefined;
  constructor(readonly db:ChatDatabase,readonly id:string,private guard?:McpMutationGuard){this.base=new PostgresProjectRepository(db,id);}
  get root(){return this.base.root;}
  get documentId(){return this.id;}
  readSnapshot(hash:string){return this.base.readSnapshot(hash);}
  async restoreRevision(revision:number){
    if(!this.pending||!this.mutationClient)throw Error('Восстановление доступно только внутри операции документа.');
    const restored=await loadRestorableRevisionIn(this.mutationClient,this.db.tenant,this.id,revision);
    this.designSourceRevision=revision;
    for(const [hash,bytes] of restored.files)this.pending.set(hash,bytes);
    return {doc:restored.doc,sources:restored.sources};
  }
  readRevisionSources(revision:number){return this.base.readRevisionSources(revision);}
  readRevisionAsset(revision:number,id:string){return this.base.readRevisionAsset(revision,id);}
  readFile(key:string,max?:number){return this.base.readFile(key,max);}
  writeExport(name:"presentation.pptx"|"presentation.pdf"|"lanka-handoff.json",bytes:Uint8Array){return this.base.writeExport(name,bytes);}
  saveExportArtifact(manifest:ExportManifest,bytes:Uint8Array){if(this.guard)throw Error('Экспорт недоступен из поручения чата.');return this.base.saveExportArtifact(manifest,bytes);}
  listExportArtifacts(cursor?:string){return this.base.listExportArtifacts(cursor);}
  readExportManifest(id:string){return this.base.readExportManifest(id);}
  readExportArtifact(id:string){return this.base.readExportArtifact(id);}
  async read():Promise<FolderProject|null> {
    if(!await this.db.owns(this.id))return null;
    return this.base.read(); // Trashed documents fail closed, including receipt replays.
  }
  async writeMaterial(bytes:Buffer) {
    if(!this.pending)throw new Error("Материалы можно писать только внутри операции документа.");
    if(bytes.length>5_000_000)throw new Error("Материал превышает лимит.");
    const hash=createHash("sha256").update(bytes).digest("hex");this.pending.set(hash,Buffer.from(bytes));return hash;
  }
  async mutate(requestId:string,payload:unknown,change:(old:FolderProject|null)=>Promise<{project:FolderProject;result:unknown}>) {
    return this.db.tx(async c=>{
      await this.guard?.before(c,payload);
      const receiptPayload=this.guard?{scope:this.guard.receiptScope,payload}:payload;
      const exists=(await c.query("SELECT 1 FROM lanka.materials WHERE tenant_id=$1 AND owner_id=$2 AND id=$3",[this.db.tenant,this.db.owner,this.id])).rowCount;
      const old=exists?await this.db.project(c,this.id,true):null;
      const prior=await this.db.receipt(c,requestId,this.id,receiptPayload);if(prior)return prior.result;
      if(this.pending)throw new Error("Операция уже выполняется.");
      this.pending=new Map();this.mutationClient=c;
      try {
        const before=this.guard?structuredClone(old):null;
        const {project,result}=await change(old);
        if(project.state.doc.id!==this.id)throw new Error("Документ находится вне подключённой области.");
        await this.guard?.after(c,before,project,result,payload);
        const blobs=Array.from(this.pending,([hash,bytes])=>({hash,bytes}));
        if(!old)return await this.db.createProjectIn(c,requestId,project,null,blobs,receiptPayload,result);
        for(const b of blobs)await c.query("INSERT INTO lanka.blobs(tenant_id,material_id,key,bytes) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",[this.db.tenant,this.id,`materials/${b.hash}.bin`,b.bytes]);
        const human=payload as {surface?:string;command?:{action?:string}};
        const label=human.surface==='human-image'?"Загружено изображение":human.surface==='human'?(human.command?.action==='restore'?"Восстановление версии":"Сохранены правки"):"Операция внешнего агента";
        await this.db.saveProject(c,this.id,project,label,this.designSourceRevision);
        await this.db.remember(c,requestId,this.id,receiptPayload,result);return result;
      } finally {this.pending=null;this.mutationClient=null;this.designSourceRevision=undefined;}
    });
  }
}
