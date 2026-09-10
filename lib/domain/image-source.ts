import {z} from 'zod';
import type {Source} from './model';
export const imageMetadataSchema=z.object({width:z.number().int().positive().max(100000),height:z.number().int().positive().max(100000),normalizedSourceId:z.string().min(1).max(80).optional(),originalSourceId:z.string().min(1).max(80).optional()}).strict();
export function imageSources(sources:Source[]){return sources.filter(s=>s.kind==='image'&&!s.image?.normalizedSourceId);}
export const imageUploadLimit=5_000_000;
export const imageUploadSchema=z.object({
 requestId:z.string().uuid(),deckId:z.string().min(1).max(80),expectedRevision:z.number().int().positive(),
 slideId:z.string().min(1).max(80),elementId:z.string().min(1).max(80).optional(),
 name:z.string().trim().min(1).max(140),contentType:z.enum(['image/png','image/jpeg']),
 base64:z.string().min(4).max(6_666_668).regex(/^[A-Za-z0-9+/]*={0,2}$/),
}).strict();
export type ImageUpload=z.infer<typeof imageUploadSchema>;
