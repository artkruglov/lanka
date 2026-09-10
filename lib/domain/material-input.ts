import {imageMetadataSchema} from './image-source';
import { z } from "zod";
export const materialInputsSchema=z.array(z.object({
  id:z.string().min(1).max(80),name:z.string().trim().min(1).max(140),
  contentType:z.enum(["text/plain","text/markdown","text/csv","application/json","image/png","image/jpeg"]),
  image:imageMetadataSchema.optional(),
  base64:z.string().min(4).max(800000).regex(/^[A-Za-z0-9+/]*={0,2}$/),
}).strict()).max(30).refine(a=>new Set(a.map(s=>s.id)).size===a.length,"Duplicate source IDs");
export type MaterialInput=z.infer<typeof materialInputsSchema>[number];
