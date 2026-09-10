import type { FolderProject } from "./package";
import type { DeckDoc, State } from "../domain/model";
import type {ExportManifest,ExportPage} from './export-artifact';

/** The editor and tools share these operations; storage owns the transaction. */
export interface ProjectRepository {
  readonly root: string;
  read(): Promise<FolderProject | null>;
  mutate(
    requestId: string,
    payload: unknown,
    change: (old: FolderProject | null) => Promise<{project: FolderProject; result: unknown}>,
  ): Promise<unknown>;
  readSnapshot(hash: string): Promise<DeckDoc>;
  /** Restore captured dependencies inside the active mutation; absence denotes legacy file storage. */
  restoreRevision?(revision:number):Promise<{doc:DeckDoc;sources:State['sources']}>;
  readRevisionSources?(revision:number):Promise<Pick<import('./revision-dependencies').RevisionDependencies,'sources'|'unavailable'>|null>;
  readRevisionAsset?(revision:number,id:string):Promise<{bytes:Buffer;contentType:string}>;
  readFile(path: string, max?: number): Promise<Buffer>;
  writeExport(name: "presentation.pptx" | "presentation.pdf" | "lanka-handoff.json", bytes: Uint8Array): Promise<string>;
  saveExportArtifact(manifest:ExportManifest,bytes:Uint8Array):Promise<string>;
  listExportArtifacts(cursor?:string):Promise<ExportPage>;
  readExportManifest(id:string):Promise<ExportManifest>;
  readExportArtifact(id:string):Promise<Buffer>;
}
