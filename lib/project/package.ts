import {
  validateDoc,
  validateReferences,
  type Deck,
  type State,
} from "@/lib/domain/model";
import type { Briefing } from "@/lib/domain/briefing";
export type FolderProject = {
  format: "lanka-project/v1";
  title: string;
  state: State;
  receipts: { id: string; hash: string; result: unknown }[];
  briefing?: Briefing;
  draftShell?: {revision:number;hash:string;allowTitle?:boolean;sourceHash?:string};
  history?: {revision: number; createdAt: string; action: string; hash: string; dependenciesHash?:string}[];
};
export const materialPath = (hash: string) => {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid source hash");
  return `materials/${hash}.bin`;
};
export function folderProject(deck: Deck): FolderProject {
  const state = structuredClone(deck.state);
  state.doc = validateDoc(state.doc);
  // Folder access is owned by the document repository. Application ACL/approvals never travel as credentials.
  state.grants = [];
  state.approvedRevision = null;
  state.approvedBy = null;
  validateReferences(state);
  return {
    format: "lanka-project/v1",
    title: state.doc.title,
    state,
    receipts: [],
  };
}
export async function projectZip(
  project: FolderProject,
  loadSource: (id: string) => Promise<Uint8Array>,
) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  let total = 0;
  for (const source of project.state.sources) {
    const bytes = await loadSource(source.id);
    total += bytes.length;
    if (bytes.length > 5_000_000 || total > 40_000_000)
      throw new Error("Папка проекта превышает лимит 40 МБ.");
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== source.sha256)
      throw new Error("Файл изменился: скачайте проект снова.");
    zip.file(materialPath(hash), bytes);
  }
  zip.file("project.json", JSON.stringify(project, null, 2));
  zip.file(
    "presentation/deck.json",
    JSON.stringify(project.state.doc, null, 2),
  );
  zip.file("brief.txt", JSON.stringify(project.state.doc.brief || {}, null, 2));
  zip.file(
    "feedback/comments.json",
    JSON.stringify(project.state.comments, null, 2),
  );
  zip.file(
    "README.txt",
    "Lanka project folder\n\nproject.json is the authoritative local project state. presentation/deck.json, brief.txt and feedback/comments.json are exported views, not live synced files.\nMaterials use immutable SHA-256 filenames; original names and IDs are in project.json.\nConnect the local project MCP with --root pointing to this folder. It can access this project only and cannot approve/publish.\nFolder sharing is managed by your organization repository. App ACL and approval are not imported. This download is a snapshot, not automatic synchronization.\nDo not run two writers through consumer drive sync. Use one local writer and send proposals back for review.\n",
  );
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 3 },
  });
}
