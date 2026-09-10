import {z} from 'zod';
import {exportCapabilitiesSchema} from './export-capabilities';
import {docSchema} from '../domain/model';
import {imageMetadataSchema} from '../domain/image-source';
import {sourceExtractionSchema} from '../domain/source-extraction';
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const exportManifestSchema=z.object({
 format:z.literal('lanka-export/v1'),id:z.string().uuid(),createdAt:z.string().datetime(),
 documentId:z.string(),revision:z.number().int().positive(),title:z.string(),
 output:z.object({format:z.enum(['pdf','pptx']),sha256:hash,bytes:z.number().int().positive().max(40_000_000)}).strict(),
 documentHash:hash,snapshot:docSchema,
 sources:z.array(z.object({id:z.string(),name:z.string(),kind:z.enum(['text','image','document']),sha256:hash,contentType:z.string(),createdAt:z.string(),excerpt:z.string(),extraction:sourceExtractionSchema.optional(),image:imageMetadataSchema.optional(),bytes:z.number().int().nonnegative()}).strict()),
 renderer:z.object({buildHash:hash,packageVersion:z.string(),nodeVersion:z.string()}).strict(),
 fonts:z.array(z.object({file:z.string(),sha256:hash,embedded:z.boolean()}).strict()),
 approval:z.literal('not-a-release'),
 capabilities:exportCapabilitiesSchema.optional(),
}).strict();
export type ExportManifest=z.infer<typeof exportManifestSchema>;
export type ExportSummary=Omit<ExportManifest,'snapshot'|'sources'|'renderer'|'fonts'>;
export function exportSummary(m:ExportManifest):ExportSummary {
 const {snapshot,sources,renderer,fonts,...summary}=m;return summary;
}
export type ExportPage={items:ExportSummary[];nextCursor:string|null};
export const exportId=(id:string)=>z.string().uuid().parse(id);
export const exportKey=(id:string,name:string)=>`exports/${exportId(id)}/${name}`;
