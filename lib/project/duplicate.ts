import {z} from 'zod';
import {initialState,validateDoc,validateReferences} from '../domain/model';
import type {FolderProject} from './package';
export const duplicateCommandSchema=z.object({action:z.literal('duplicate_document'),id:z.string().uuid(),expectedRevision:z.number().int().positive(),title:z.string().trim().min(1).max(140),folderId:z.string().uuid().nullable()}).strict();
export type DuplicateCommand=z.infer<typeof duplicateCommandSchema>;
/** Content is reusable; discussion, approvals, grants, receipts and history are not. */
export function duplicateProject(source:FolderProject,id:string,title:string,expectedRevision:number):FolderProject{
 if(source.state.revision!==expectedRevision)throw Error('Конфликт версии: обновите библиотеку перед созданием копии.');
 const doc=validateDoc({...structuredClone(source.state.doc),id,title});
 const state=initialState(doc);state.sources=structuredClone(source.state.sources);validateReferences(state);
 return {format:'lanka-project/v1',title,state,receipts:[],...(source.briefing?{briefing:structuredClone(source.briefing)}:{})};
}
