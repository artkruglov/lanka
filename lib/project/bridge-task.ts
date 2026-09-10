import {z} from 'zod';
export const bridgeTaskSchema=z.object({mode:z.enum(['discuss','propose','create','comment','organize']),documentId:z.string().uuid().optional(),limitToSelection:z.boolean().optional()}).strict();
export const bridgeTaskAddressSchema=z.object({sessionId:z.string().uuid(),messageId:z.string().uuid(),executionId:z.string().uuid().optional()}).strict();
export type BridgeTaskAddress=z.infer<typeof bridgeTaskAddressSchema>;
