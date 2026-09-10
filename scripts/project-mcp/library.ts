import {duplicateCommandSchema,duplicateProject} from '../../lib/project/duplicate';
import {materialPath} from '../../lib/project/package';
import {createHash} from 'node:crypto';
import { mkdir, open, rename, unlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import { z } from "zod";
import { ProjectStore } from "./store";
import { humanCommand } from "./human";
import { emptyDraft } from "../../lib/project/empty-draft";
import {assertLocalAvailable} from '../../lib/project/local-migration';
const name = z.string().trim().min(1).max(180),
  id = z.string().uuid();
const folder = z.object({ id, name });
const document = z.object({
  id,
  title: name,
  folderId: id.nullable(),
  createdAt: z.string(),
  trashed: z.boolean(),
});
const schema = z.object({
  format: z.literal("lanka-library/v1"),
  folders: z.array(folder).max(100),
  documents: z.array(document).max(500),
  receipts: z
    .array(z.object({ id, payload: z.string(), result: z.unknown() }))
    .max(2000),
});
export const libraryCommandSchema = z.discriminatedUnion("action", [
  duplicateCommandSchema,
  z.object({ action: z.literal("create_folder"), name }),
  z.object({ action: z.literal("rename_folder"), id, name }),
  z.object({
    action: z.literal("create_document"),
    title: name,
    folderId: id.nullable(),
    markdown: z.string().max(30000).optional(),
    empty:z.literal(true).optional(),
    profile:z.enum(["focus-v2","focus-v3"]).optional(),
    sourceIntakeId:id.optional(),
  }),
  z.object({ action: z.literal("move_document"), id, folderId: id.nullable() }),
  z.object({ action: z.literal("trash_document"), id, trashed: z.boolean() }),
]);
export class LibraryStore {
  constructor(readonly root: string,readonly migrationRead=false) {}
  async init() {
    await mkdir(this.root, { recursive: true });
    if ((await realpath(this.root)) !== this.root)
      throw new Error("Library requires a real directory");
    const dir = join(this.root, "documents");
    await mkdir(dir, { recursive: true });
    if ((await realpath(dir)) !== dir)
      throw new Error("Linked documents are not allowed");
  }
  async read() {
    await this.init();
    if(!this.migrationRead)await assertLocalAvailable(this.root);
    let file;
    try {
      file = await open(
        join(this.root, "library.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return schema.parse({
          format: "lanka-library/v1",
          folders: [],
          documents: [],
          receipts: [],
        });
      throw e;
    }
    try {
      if ((await file.stat()).size > 2_000_000)
        throw new Error("Library exceeds limit");
      return schema.parse(JSON.parse(await file.readFile("utf8")));
    } finally {
      await file.close();
    }
  }
  async project(documentId: string, includeTrash = false) {
    const data = await this.read(),
      key = id.parse(documentId);
    if (
      !data.documents.some((d) => d.id === key && (includeTrash || !d.trashed))
    )
      throw new Error("Документ недоступен в библиотеке.");
    const store = new ProjectStore(join(this.root, "documents", key),this.migrationRead);
    await store.checkRoot();
    return store;
  }
  async listing() {
    const data = await this.read();
    const documents = await Promise.all(
      data.documents.map(async (d) => {
        const p = await (await this.project(d.id, true)).read();
        return {
          ...d,
          title: p?.title || d.title,
          revision: p?.state.revision || 0,
          slideCount: p?.state.doc.slides.length || 0,
          design: p?.state.doc.design,
          preview: p
            ? { slide: p.state.doc.slides[0], brand: p.state.doc.brand }
            : null,
          pending:
            p?.state.proposals.filter((p) => p.status === "pending").length ||
            0,
          updatedAt: p?.history?.at(-1)?.createdAt || d.createdAt,
        };
      }),
    );
    return { folders: data.folders, documents };
  }
  async mutate(input: unknown) {
    const a = z.object({ requestId: id, command:libraryCommandSchema }).strict().parse(input);
    await this.init();
    await assertLocalAvailable(this.root);
    const lock = join(this.root, "library.lock"),
      fd = await open(lock, "wx", 0o600).catch(() => {
        throw new Error("Библиотека занята. Повторите действие.");
      });
    let tmp: string | undefined;
    try {
      await assertLocalAvailable(this.root);
      const data = await this.read(),
        payload = JSON.stringify(a.command),
        prior = data.receipts.find((r) => r.id === a.requestId);
      if (prior) {
        if (prior.payload !== payload) throw new Error("requestId reused");
        return prior.result;
      }
      const c = a.command;
      let result: unknown = { ok: true };
      if (c.action === "create_folder") {
        data.folders.push({ id: a.requestId, name: c.name });
        result = { id: a.requestId };
      } else if (c.action === "rename_folder") {
        const f = data.folders.find((f) => f.id === c.id);
        if (!f) throw new Error("Папка недоступна");
        f.name = c.name;
      } else if(c.action==='duplicate_document') {
        if(c.folderId&&!data.folders.some(f=>f.id===c.folderId))throw Error('Папка недоступна.');
        const original=data.documents.find(d=>d.id===c.id&&!d.trashed);if(!original)throw Error('Документ недоступен.');
        const root=join(this.root,'documents',a.requestId);await mkdir(root,{recursive:true});const target=new ProjectStore(root);
        result=await target.mutate(a.requestId,c,async old=>{
          if(old)throw Error('Документ уже существует.');
          const repository=await this.project(c.id),source=await repository.read();if(!source)throw Error('Документ недоступен.');
          const project=duplicateProject(source,a.requestId,c.title,c.expectedRevision);let total=0;
          for(const item of project.state.sources){const bytes=await repository.readFile(materialPath(item.sha256));if((total+=bytes.length)>40_000_000)throw Error('Материалы превышают лимит.');if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('Файл источника изменился.');await target.writeMaterial(bytes);}
          return {project,result:{id:a.requestId,revision:1}};
        });
        data.documents.push({id:a.requestId,title:c.title,folderId:c.folderId,createdAt:new Date().toISOString(),trashed:false});
      } else if (c.action === "create_document") {
        if(c.sourceIntakeId)throw Error('Файлы подготовки требуют PostgreSQL-подключения библиотеки.');
        if (c.folderId && !data.folders.some((f) => f.id === c.folderId))
          throw new Error("Папка недоступна");
        const root = join(this.root, "documents", a.requestId);
        await mkdir(root, { recursive: true });
        if(c.empty){
          if(c.markdown!==undefined)throw new Error("Пустая заготовка не принимает Markdown.");
          const p=await emptyDraft(a.requestId,c.title,c.profile||"focus-v2");
          await new ProjectStore(root).mutate(a.requestId,c,async old=>{if(old)throw new Error("Документ уже существует.");return {project:p,result:{id:a.requestId,revision:1}};});
        } else
          await humanCommand(new ProjectStore(root), {
            requestId: a.requestId,
            command: {
              action: "create",
              markdown: c.markdown || `# ${c.title}\n\n## Главная мысль\nДобавьте содержание или обсудите его с агентом.`,
              ...(c.profile?{profile:c.profile}:{}),
            },
          });
        data.documents.push({
          id: a.requestId,
          title: c.title,
          folderId: c.folderId,
          createdAt: new Date().toISOString(),
          trashed: false,
        });
        result = { id: a.requestId };
      } else {
        const d = data.documents.find((d) => d.id === c.id);
        if (!d) throw new Error("Документ недоступен");
        if (c.action === "move_document") {
          if (c.folderId && !data.folders.some((f) => f.id === c.folderId))
            throw new Error("Папка недоступна");
          d.folderId = c.folderId;
        } else d.trashed = c.trashed;
      }
      data.receipts.push({ id: a.requestId, payload, result });
      schema.parse(data);
      tmp = join(this.root, `pending-${a.requestId}.json`);
      const out = await open(tmp, "wx", 0o600);
      try {
        await out.writeFile(JSON.stringify(data, null, 2));
        await out.sync();
      } finally {
        await out.close();
      }
      await rename(tmp, join(this.root, "library.json"));
      tmp = undefined;
      return result;
    } finally {
      if (tmp) await unlink(tmp).catch(() => {});
      await fd.close();
      await unlink(lock);
    }
  }
}
