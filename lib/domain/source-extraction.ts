import { z } from "zod";

export const sourceExtractionSchema=z.object({
  parser:z.object({name:z.literal('lanka-source'),version:z.literal(1),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  status:z.enum(['extracted','partial','unsupported','failed']),note:z.string().max(500),
  fragments:z.array(z.object({locator:z.string().min(1).max(150),text:z.string().min(1).max(2000)}).strict()).max(80),
}).strict();
export type SourceExtraction=z.infer<typeof sourceExtractionSchema>;
export const sourceIntakeViewSchema=z.object({id:z.string().uuid(),name:z.string(),sha256:z.string(),size:z.number(),createdAt:z.string(),expiresAt:z.string(),extraction:sourceExtractionSchema}).strict();
export type SourceIntakeView=z.infer<typeof sourceIntakeViewSchema>;
