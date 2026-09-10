import {creationDesignBrand} from '../../lib/domain/creation-design';
import {duplicateCommandSchema} from '../../lib/project/duplicate';
import { z } from "zod";
import { LibraryStore,libraryCommandSchema } from "./library";
import { ChatDatabase } from "../../lib/adapters/postgres/chat-database";
import { PostgresMcpRepository } from "../../lib/adapters/postgres/mcp-repository";
import { fromMarkdown } from "../../lib/domain/intake";
import { emptyDraft } from "../../lib/project/empty-draft";
import {adoptSourceIntake} from '../../lib/agents/source-intake';

/** Shared local application service for the HTTP library and workspace MCP.
 * Existing file documents stay in place; new documents use PG when configured.
 */
export class LocalWorkspace {
  constructor(readonly library:LibraryStore,readonly db?:ChatDatabase) {}
  async serverCatalog(){return this.db?!!await this.db.catalogInfo():false;}
  async folders(){return await this.serverCatalog()?this.db!.catalogFolders():(await this.library.read()).folders;}
  async resolveId(id:string){return this.db?this.db.resolveMaterialId(id):id;}
  async listing() {
    if(await this.serverCatalog())return {folders:await this.db!.catalogFolders(),documents:await this.db!.listing()};
    const listing=await this.library.listing();
    if(this.db)listing.documents.push(...await this.db.listing());
    return listing;
  }
  async repository(id:string) {
    z.string().uuid().parse(id);id=await this.resolveId(id);
    return this.db&&await this.db.owns(id)?new PostgresMcpRepository(this.db,id):this.library.project(id);
  }
  async mutate(input:unknown) {
    const a=z.object({requestId:z.string().uuid(),command:z.record(z.unknown())}).strict().parse(input);
    const server=await this.serverCatalog();
    if(server){
      a.command=libraryCommandSchema.parse(a.command);
      const prior=await this.db!.catalogReceipt(a.requestId,a.command);if(prior)return prior.result;
      if(a.command.action==='create_folder'||a.command.action==='rename_folder')return this.db!.mutateFolder(a.requestId,a.command);
    }
    if(this.db&&a.command.action==='duplicate_document'){
      const cmd=duplicateCommandSchema.parse(a.command),sourceId=await this.resolveId(cmd.id);
      if(await this.db.owns(sourceId))return this.db.tx(c=>this.db!.duplicateIn(c,a.requestId,cmd,sourceId));
      if(server)throw Error('Документ недоступен.');
      return this.library.mutate(a);
    }
    if(this.db&&a.command.action==="create_document") {
      const c=z.object({action:z.literal("create_document"),title:z.string().trim().min(1).max(140),folderId:z.string().uuid().nullable(),markdown:z.string().max(30000).optional(),empty:z.literal(true).optional(),profile:z.enum(["focus-v2","focus-v3"]).optional(),sourceIntakeId:z.string().uuid().optional()}).strict().parse(a.command);
      if(c.sourceIntakeId&&!c.empty)throw Error('Источник подключается к новой пустой заготовке.');
      if(c.folderId&&!(await this.folders()).some(f=>f.id===c.folderId))throw new Error("Папка недоступна.");
      if(c.empty){
        if(c.markdown!==undefined)throw new Error("Пустая заготовка не принимает Markdown.");
        const p=await emptyDraft(a.requestId,c.title,c.profile||"focus-v2");
        return this.db.tx(async tx=>{
          const prior=await this.db!.receipt(tx,a.requestId,a.requestId,c);if(prior)return prior.result;
          const blobs:{hash:string;bytes:Buffer}[]=[];
          if(c.sourceIntakeId)await adoptSourceIntake(this.db!,tx,c.sourceIntakeId,p,blobs);
          return this.db!.createProjectIn(tx,a.requestId,p,c.folderId,blobs,c,{id:a.requestId,revision:1});
        });
      }
      const doc=fromMarkdown(c.markdown||`# ${c.title}\n\n## Главная мысль\nДобавьте содержание или обсудите его с агентом.`);doc.id=a.requestId;doc.title=c.title;
      if(c.profile){doc.design=c.profile;doc.brand=creationDesignBrand(c.profile);}
      return this.db.create(a.requestId,doc,c.folderId,[],[],c);
    }
    const target=typeof a.command.id==='string'?await this.resolveId(a.command.id):null;
    if(this.db&&target&&await this.db.owns(target)) {
      const c=z.discriminatedUnion("action",[z.object({action:z.literal("move_document"),id:z.string().uuid(),folderId:z.string().uuid().nullable()}).strict(),z.object({action:z.literal("trash_document"),id:z.string().uuid(),trashed:z.boolean()}).strict()]).parse(a.command);
      if(c.action==="move_document"&&c.folderId&&!(await this.folders()).some(f=>f.id===c.folderId))throw new Error("Папка недоступна.");
      return this.db.catalogCommand(a.requestId,target,c);
    }
    if(server)throw Error("Документ недоступен.");
    return this.library.mutate(a);
  }
}
