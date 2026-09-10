import {AsyncLocalStorage} from 'node:async_hooks';
import {resolve} from 'node:path';
import {z} from 'zod';
import type {BrowserPrincipal} from '../../server/browser-identity';
import type {ProjectRepository} from '../../project/repository';
import type {FolderProject} from '../../project/package';
import type {ExportManifest} from '../../project/export-artifact';
import {PostgresOrganizationAccess} from './organization-access';
import {usingTransactionDatabase} from './transaction-database';
import {PostgresMcpRepository} from './mcp-repository';

/** Personal document operations. Resource sharing will require a separate visibility/ACL projection. */
export class OrganizationProjectRepository implements ProjectRepository {
 readonly root:string;
 private current=new AsyncLocalStorage<PostgresMcpRepository>();
 constructor(private access:PostgresOrganizationAccess,private principal:BrowserPrincipal,private tenantId:string,readonly documentId:string,private runtimeRoot:string) {
  z.string().uuid().parse(tenantId);z.string().uuid().parse(documentId);this.root=resolve(runtimeRoot,tenantId,documentId);
 }
 private using<T>(fn:(repo:PostgresMcpRepository)=>Promise<T>):Promise<T> {
  const nested=this.current.getStore();if(nested)return fn(nested);
  return this.access.withTenant(this.principal,this.tenantId,(c,ctx)=>usingTransactionDatabase(c,ctx,this.runtimeRoot,async db=>{
   // Check existence and owner before receipt replay or dependency reads. This entry cannot create an unregistered document.
   await db.project(c,this.documentId);
   const repo=new PostgresMcpRepository(db,this.documentId);
   return this.current.run(repo,()=>fn(repo));
  }));
 }
 read(){return this.using(r=>r.read());}
 mutate(requestId:string,payload:unknown,change:(old:FolderProject|null)=>Promise<{project:FolderProject;result:unknown}>){return this.using(r=>r.mutate(requestId,payload,change));}
 readSnapshot(hash:string){return this.using(r=>r.readSnapshot(hash));}
 restoreRevision(revision:number){return this.using(r=>r.restoreRevision(revision));}
 readRevisionSources(revision:number){return this.using(r=>r.readRevisionSources(revision));}
 readRevisionAsset(revision:number,id:string){return this.using(r=>r.readRevisionAsset(revision,id));}
 readFile(path:string,max?:number){return this.using(r=>r.readFile(path,max));}
 writeExport(name:'presentation.pptx'|'presentation.pdf'|'lanka-handoff.json',bytes:Uint8Array){return this.using(r=>r.writeExport(name,bytes));}
 saveExportArtifact(m:ExportManifest,bytes:Uint8Array){return this.using(r=>r.saveExportArtifact(m,bytes));}
 listExportArtifacts(cursor?:string){return this.using(r=>r.listExportArtifacts(cursor));}
 readExportManifest(id:string){return this.using(r=>r.readExportManifest(id));}
 readExportArtifact(id:string){return this.using(r=>r.readExportArtifact(id));}
 async writeMaterial(bytes:Buffer){
  const repo=this.current.getStore();if(!repo)throw Error('Материалы можно писать только внутри операции документа.');
  return repo.writeMaterial(bytes);
 }
}
