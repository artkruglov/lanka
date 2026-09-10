import type {ResourceRole} from '../server/resource-access';

/** A catalogue entry deliberately contains no editor package, sources or review data. */
export type SharedLibrary = {
 format:'lanka-shared-library/v1';
 folders?:{id:string;resourceId:string;name:string;parentId:string|null;role:ResourceRole}[];
 folder?:{id:string;name:string;role:ResourceRole}|null;
 documents:{id:string;title:string;revision:number;updatedAt:string;role:ResourceRole;reactions?:{likes:number;liked:boolean;bookmarked:boolean}}[];
 nextCursor:string|null;
};
