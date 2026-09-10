import {z} from 'zod';
/** An address in an explicitly linked document, frozen when the message is sent. */
export const bridgeSelectionSchema=z.object({
 documentId:z.string().uuid(),revision:z.number().int().positive(),
 slideId:z.string().min(1).max(200),elementId:z.string().min(1).max(200).optional(),
 field:z.enum(['title','body','takeaway']).optional(),
}).strict().refine(v=>!v.elementId||!v.field,'Choose an object or a semantic field.');
export type BridgeSelection=z.infer<typeof bridgeSelectionSchema>;
