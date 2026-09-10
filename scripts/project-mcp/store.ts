import {AsyncLocalStorage} from 'node:async_hooks';
import {canonicalJson} from '../../lib/domain/canonical-json';
import {captureRevisionDependencies,type RevisionDependencies} from '../../lib/project/revision-dependencies';
import { open, rename, unlink, lstat, realpath, mkdir, link } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { FolderProject } from "../../lib/project/package";
import { validateDoc, validateReferences, type DeckDoc } from "../../lib/domain/model";
import {saveArtifact,listArtifacts,readManifest,readArtifact} from './export-store';
import type {ExportManifest} from '../../lib/project/export-artifact';
import {assertLocalAvailable} from '../../lib/project/local-migration';
const sha=(v:Uint8Array|string)=>createHash("sha256").update(v).digest("hex");
export class ProjectStore {
  private mutation=new AsyncLocalStorage<Map<string,Buffer>>();
  constructor(readonly root: string,readonly migrationRead=false) {}
  async exclusiveWrite<T>(fn:()=>Promise<T>):Promise<T>{
    await this.checkRoot();const path=join(this.root,'write.lock'),lock=await open(path,'wx',0o600).catch(()=>{throw Error('Project is locked. Check the other writer; no automatic lock takeover.');});
    try{await assertLocalAvailable(this.root,true);return await fn();}finally{await lock.close();await unlink(path);}
  }
  saveExportArtifact(manifest:ExportManifest,bytes:Uint8Array){return saveArtifact(this,manifest,bytes);}
  listExportArtifacts(cursor?:string){return listArtifacts(this,cursor);}
  readExportManifest(id:string){return readManifest(this,id);}
  readExportArtifact(id:string){return readArtifact(this,id);}
  async checkRoot() {
    const p = resolve(this.root);
    if ((await realpath(p)) !== p || !(await lstat(p)).isDirectory())
      throw new Error("Project root must be an existing real directory");
    if(!this.migrationRead)await assertLocalAvailable(this.root,true);
  }
  async readFile(path: string, max = 5_000_000) {
    await this.checkRoot();
    if (!/^(project\.json|((?:materials|revision-files)\/[a-f0-9]{64}\.bin|(?:revisions|revision-sources)\/[a-f0-9]{64}\.json))$/.test(path))
      throw new Error("Path is outside project");
    if (
      path.includes("/") &&
      (await lstat(join(this.root, path.split("/")[0]))).isSymbolicLink()
    )
      throw new Error("Linked materials are not allowed");
    const file = await open(
      join(this.root, path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > max)
        throw new Error("Project file exceeds limit");
      return await file.readFile();
    } finally {
      await file.close();
    }
  }
  async read(): Promise<FolderProject | null> {
    let bytes;
    try {
      bytes = await this.readFile("project.json", 1_500_000);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    const p = JSON.parse(bytes.toString("utf8")) as FolderProject;
    if (
      p.format !== "lanka-project/v1" ||
      !Number.isInteger(p.state?.revision) ||
      p.state.revision < 1 ||
      !Array.isArray(p.receipts)
    )
      throw new Error("Invalid project format");
    p.state.doc = validateDoc(p.state.doc);
    validateReferences(p.state);
    return p;
  }
  async mutate(
    id: string,
    payload: unknown,
    fn: (
      old: FolderProject | null,
    ) => Promise<{ project: FolderProject; result: unknown }>,
  ) {
    await this.checkRoot();
    const lock = join(this.root, "write.lock");
    const fd = await open(lock, "wx", 0o600).catch(() => {
      throw new Error(
        "Project is locked. Check the other writer; no automatic lock takeover.",
      );
    });
    let tmp: string | undefined;
    try {
      await assertLocalAvailable(this.root,true);
      await fd.writeFile(
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
      );
      const old = await this.read(),
        hash = createHash("sha256")
          .update(JSON.stringify(payload))
          .digest("hex");
      const prior = old?.receipts.find((r) => r.id === id);
      if (prior) {
        if (prior.hash !== hash)
          throw new Error("requestId was reused for a different command");
        return prior.result;
      }
      const previous = old ? structuredClone(old) : null;
      const restoredFiles=new Map<string,Buffer>();
      const { project, result } = await this.mutation.run(restoredFiles,()=>fn(old));
      for(const bytes of restoredFiles.values())await this.writeMaterial(bytes);
      const history = [...(previous?.history || [])];
      if (previous && !history.some(h => h.revision === previous.state.revision))
        history.push(await this.snapshot(previous.state.doc, previous.state.revision, "Исходная версия"));
      if (!previous || project.state.revision !== previous.state.revision) {
        const action = (payload as {surface?: string; command?: {action?: string}})?.command?.action;
        const label = action === "restore" ? "Восстановление версии" : action === "accept" ? "Приняты изменения" : previous ? "Сохранены правки" : "Создан документ";
        history.push(await this.snapshotProject(project,label));
      }
      project.history = history;
      if ((old?.receipts.length || 0) >= 500)
        throw new Error(
          "Project command limit reached; archive before continuing",
        );
      project.receipts = [...(old?.receipts || []), { id, hash, result }];
      const bytes = JSON.stringify(project, null, 2);
      if (Buffer.byteLength(bytes) > 1_500_000)
        throw new Error("Project exceeds limit");
      tmp = join(this.root, `pending-${randomUUID()}.json`);
      const out = await open(tmp, "wx", 0o600);
      try {
        await out.writeFile(bytes);
        await out.sync();
      } finally {
        await out.close();
      }
      await rename(tmp, join(this.root, "project.json"));
      tmp = undefined;
      const directory=await open(this.root,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}
      return result;
    } finally {
      if (tmp) await unlink(tmp).catch(() => {});
      await fd.close();
      await unlink(lock);
    }
  }
  private async immutable(directory:'revisions'|'revision-sources'|'revision-files'|'materials',hash:string,bytes:Uint8Array){
    await this.checkRoot();await assertLocalAvailable(this.root,true);
    if(!/^[a-f0-9]{64}$/.test(hash)||sha(bytes)!==hash)throw Error('Invalid immutable file hash');
    const dir=join(this.root,directory),ext=directory==='materials'||directory==='revision-files'?'bin':'json';
    await mkdir(dir,{recursive:true});if(await realpath(dir)!==dir||!(await lstat(dir)).isDirectory())throw Error('Linked archive directories are not allowed');
    const name=`${directory}/${hash}.${ext}`,temporary=join(dir,`pending-${randomUUID()}`);
    try{if(sha(await this.readFile(name,5_000_000))!==hash)throw Error('Immutable file hash mismatch');return;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    const file=await open(temporary,'wx',0o600);
    try{
      await file.writeFile(bytes);await file.sync();await file.close();
      try{await link(temporary,join(this.root,name));}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
      if(sha(await this.readFile(name,5_000_000))!==hash)throw Error('Immutable file hash mismatch');
    }finally{await file.close().catch(()=>{});await unlink(temporary);}
    const fd=await open(dir,constants.O_RDONLY);try{await fd.sync();}finally{await fd.close();}
  }
  async snapshot(doc: DeckDoc, revision: number, action: string) {
    const bytes=Buffer.from(JSON.stringify(doc)),hash=sha(bytes);
    await this.immutable('revisions',hash,bytes);await this.readSnapshot(hash);
    return {revision,action,hash,createdAt:new Date().toISOString()};
  }
  private async snapshotProject(project:FolderProject,action:string){
    const captured=await captureRevisionDependencies(project,async hash=>{
      try{return await this.readFile(`materials/${hash}.bin`);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}
    });
    for(const blob of captured.blobs)await this.immutable('revision-files',blob.hash,blob.bytes);
    await this.immutable('revision-sources',captured.hash,captured.bytes);
    return {...await this.snapshot(project.state.doc,project.state.revision,action),dependenciesHash:captured.hash};
  }
  async readRevisionDependencies(revision:number){
    const p=await this.read(),entry=p?.history?.find(h=>h.revision===revision);
    if(!p||!entry?.dependenciesHash)throw Error('Для этой версии нет проверяемого архива источников.');
    const bytes=await this.readFile(`revision-sources/${entry.dependenciesHash}.json`,3_000_000);
    if(sha(bytes)!==entry.dependenciesHash)throw Error('Revision dependencies hash mismatch');
    const snapshot=JSON.parse(bytes.toString('utf8')) as RevisionDependencies,doc=await this.readSnapshot(entry.hash);
    if(snapshot.format!=='lanka-revision-dependencies/v1'||snapshot.documentId!==p.state.doc.id||doc.id!==p.state.doc.id||snapshot.revision!==revision||snapshot.documentHash!==sha(canonicalJson(doc))||!Array.isArray(snapshot.sources)||!Array.isArray(snapshot.files)||!Array.isArray(snapshot.unavailable))throw Error('Invalid revision dependencies');
    validateReferences({...p.state,doc,sources:snapshot.sources});
    const read=async(hash:string)=>{
      const files=snapshot.files.filter(f=>f.sha256===hash);
      if(files.length!==1||snapshot.unavailable.some(f=>f.sha256===hash))throw Error('Для этой версии нет проверяемого архива источников.');
      const file=await this.readFile(`revision-files/${hash}.bin`);
      if(sha(file)!==hash||file.length!==files[0].byteLength)throw Error('Revision file hash mismatch');return file;
    };
    return {snapshot,bytes,hash:entry.dependenciesHash,doc,read};
  }
  async restoreRevision(revision:number){
    const pending=this.mutation.getStore();if(!pending)throw Error('Восстановление доступно только внутри операции документа.');
    const archive=await this.readRevisionDependencies(revision),files=new Map<string,Buffer>();
    for(const source of archive.snapshot.sources)if(!files.has(source.sha256))files.set(source.sha256,await archive.read(source.sha256));
    for(const [hash,bytes] of files)pending.set(hash,bytes);
    return {doc:archive.doc,sources:archive.snapshot.sources};
  }
  async readRevisionSources(revision:number){
    const p=await this.read(),entry=p?.history?.find(h=>h.revision===revision);
    if(!entry)throw Error('Версия недоступна.');
    if(!entry.dependenciesHash)return null;
    const {snapshot}=await this.readRevisionDependencies(revision);return {sources:snapshot.sources,unavailable:snapshot.unavailable};
  }
  async readRevisionAsset(revision:number,id:string){
    const archive=await this.readRevisionDependencies(revision),sources=archive.snapshot.sources.filter(s=>s.id===id&&s.kind==='image'&&['image/png','image/jpeg'].includes(s.contentType));
    if(sources.length!==1)throw Error('Изображение версии недоступно.');
    return {bytes:await archive.read(sources[0].sha256),contentType:sources[0].contentType};
  }
  async readSnapshot(hash: string) {
    const bytes = await this.readFile(`revisions/${hash}.json`, 1_500_000);
    if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("Revision hash mismatch");
    return validateDoc(JSON.parse(bytes.toString("utf8")));
  }
  async writeMaterial(bytes: Uint8Array) {
    if(!bytes.length||bytes.length>5_000_000)throw Error('Source limit is 5 MB');
    const hash=sha(bytes);await this.immutable('materials',hash,bytes);return hash;
  }
  async writeExport(
    name: "presentation.pptx" | "presentation.pdf" | "lanka-handoff.json",
    bytes: Uint8Array,
  ) {
    return this.exclusiveWrite(()=>this.writeExportLocked(name,bytes));
  }
  private async writeExportLocked(name:"presentation.pptx"|"presentation.pdf"|"lanka-handoff.json",bytes:Uint8Array){
    await this.checkRoot();
    const path = join(this.root, "exports");
    await mkdir(path, { recursive: true });
    if (
      (await lstat(path)).isSymbolicLink() ||
      !(await lstat(path)).isDirectory()
    )
      throw new Error("Linked exports are not allowed");
    const file = join(path, name);
    try {
      if ((await lstat(file)).isSymbolicLink())
        throw new Error("Linked export file is not allowed");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const temp = join(path, `pending-${randomUUID()}`);
    const fd = await open(temp, "wx", 0o600);
    try {
      await fd.writeFile(bytes);
      await fd.sync();
      await fd.close();
      await rename(temp, file);
    } finally {
      await fd.close().catch(() => {});
      await unlink(temp).catch(() => {});
    }
    return file;
  }
}
