import {z} from 'zod';
export const resourceRole=z.enum(['viewer','commenter','editor','manager']);
export type ResourceRole=z.infer<typeof resourceRole>;
export const roleRank:Record<ResourceRole,number>={viewer:1,commenter:2,editor:3,manager:4};
const id=z.string().uuid(),subject=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('principal'),id}).strict(),z.object({kind:z.literal('group'),id}).strict(),
]);
export const resourceCommand=z.discriminatedUnion('action',[
 z.object({action:z.literal('grant'),resourceId:id,subject,role:resourceRole.nullable(),canCopy:z.boolean().default(false)}).strict(),
 z.object({action:z.literal('inheritance'),resourceId:id,inheritance:z.enum(['inherit','restricted'])}).strict(),
 z.object({action:z.literal('move'),resourceId:id,parentFolderId:id.nullable()}).strict(),
 z.object({action:z.literal('group_set'),id,name:z.string().trim().min(1).max(180),status:z.enum(['active','suspended'])}).strict(),
 z.object({action:z.literal('group_member'),groupId:id,principalId:id,present:z.boolean()}).strict(),
]);
export const resourceRequest=z.object({requestId:id,expectedEpoch:z.string().regex(/^\d+$/).max(30).optional(),command:resourceCommand}).strict();
export type ResourcePermission={
 canPropose?:boolean;
 resourceId:string;kind:'folder'|'material';ownerId:string;materialId:string|null;folderId:string|null;parentFolderId:string|null;
 inheritance:'inherit'|'restricted';role:ResourceRole;canCopy:boolean;
 sources:{resourceId:string;via:'owner'|'principal'|'group';role:ResourceRole;canCopy:boolean}[];
};
