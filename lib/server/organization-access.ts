import type {BridgeSelection} from '../project/bridge-selection';
import {z} from 'zod';
export const membershipRole=z.enum(['owner','admin','member']);
export const membershipCommand=z.object({
 expectedEpoch:z.string().regex(/^\d+$/).optional(),
 requestId:z.string().uuid(),userId:z.string().uuid(),role:membershipRole,
 status:z.enum(['active','suspended']),
}).strict();
export type OrganizationContext={taskSelection?:BridgeSelection;delegation?:{folderResourceId?:string;id:string;name:string;capabilities:('read'|'comment'|'propose'|'create'|'organize'|'create_shared')[]};tenantId:string;principalId:string;userId:string;role:z.infer<typeof membershipRole>;authzEpoch:string};
export class OrganizationAccessError extends Error {
 constructor(readonly status:401|403|404|409,message='Организация или документ недоступны.') {super(message);}
}
