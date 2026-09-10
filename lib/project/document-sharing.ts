import type {ResourceRole} from '../server/resource-access';
export type ShareSubject={kind:'principal'|'group';id:string;name:string;active:boolean;memberCount?:number};
export type ShareEntry={resourceId:string;subject:ShareSubject;role:ResourceRole;canCopy:boolean;origin:'direct'|'folder'|'owner'};
export type DocumentSharing={
 format:'lanka-document-sharing/v1';authzEpoch:string;
 inheritance?:{mode:'inherit'|'restricted';hasParent:boolean;canInherit:boolean};
 entries:ShareEntry[];
 audience:{id:string;name:string;role:ResourceRole;canCopy:boolean}[];
 audienceCount:number;
};
export type ShareSearch={authzEpoch:string;subjects:ShareSubject[];hasMore:boolean};
