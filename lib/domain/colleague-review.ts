import {z} from 'zod';

const id=z.string().uuid(),version=z.number().int().positive();
export const reviewVersionSchema=z.object({revision:version,documentHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const note=z.string().trim().max(2000);
export const colleagueReviewCommandSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('create'),requestId:id,recipientId:id,target:reviewVersionSchema,note:note.default('')}).strict(),
  z.object({action:z.literal('respond'),requestId:id,id,expectedStatusVersion:version,target:reviewVersionSchema,
    outcome:z.enum(['reviewed','changes_requested']),note}).strict(),
  z.object({action:z.literal('cancel'),requestId:id,id,expectedStatusVersion:version}).strict(),
]);
const identity={id,tenantId:id,documentId:id,senderId:id,recipientId:id,target:reviewVersionSchema,note,
  createdAt:z.string().datetime(),statusVersion:version};
export const colleagueReviewSchema=z.discriminatedUnion('status',[
  z.object({...identity,status:z.literal('pending')}).strict(),
  z.object({...identity,status:z.literal('responded'),response:z.object({actorId:id,at:z.string().datetime(),outcome:z.enum(['reviewed','changes_requested']),note}).strict()}).strict(),
  z.object({...identity,status:z.literal('cancelled'),cancellation:z.object({actorId:id,at:z.string().datetime()}).strict()}).strict(),
]).superRefine((value,ctx)=>{
  if(value.statusVersion!==(value.status==='pending'?1:2))ctx.addIssue({code:'custom',message:'Некорректная версия состояния запроса.'});
  const endedAt=value.status==='responded'?value.response.at:value.status==='cancelled'?value.cancellation.at:null;
  if(endedAt&&Date.parse(endedAt)<Date.parse(value.createdAt))ctx.addIssue({code:'custom',message:'Действие предшествует запросу.'});
  if(value.senderId===value.recipientId)ctx.addIssue({code:'custom',message:'Выберите другого участника.'});
  if(value.status==='responded'&&(value.response.actorId!==value.recipientId||(value.response.outcome==='changes_requested'&&!value.response.note)))
    ctx.addIssue({code:'custom',message:'Ответ должен принадлежать адресату и объяснять замечания.'});
  if(value.status==='cancelled'&&value.cancellation.actorId!==value.senderId)ctx.addIssue({code:'custom',message:'Запрос отменяет отправитель.'});
});
export type ColleagueReview=z.infer<typeof colleagueReviewSchema>;
export class ColleagueReviewConflict extends Error {}
export class ColleagueReviewForbidden extends Error {}

/** Pure rules only. Adapter must authorize both participants against current tenant/ACL,
 * validate the version and its shareable dependencies, and persist request + receipt atomically.
 * Actor identity must come from the authenticated human session, never from command JSON.
 */
export function createColleagueReview(input:unknown,context:{id:string;tenantId:string;documentId:string;senderId:string;now:string}):ColleagueReview {
  const command=colleagueReviewCommandSchema.parse(input);
  if(command.action!=='create')throw new ColleagueReviewConflict('Ожидалось создание запроса.');
  return colleagueReviewSchema.parse({id:context.id,tenantId:context.tenantId,documentId:context.documentId,senderId:context.senderId,createdAt:context.now,
    recipientId:command.recipientId,target:command.target,note:command.note,status:'pending',statusVersion:1});
}

/** Call after receipt lookup under the same write lock as persistence. Repeats are not
 * inferred from terminal state: a different requestId cannot silently overwrite an answer.
 */
export function transitionColleagueReview(current:ColleagueReview,input:unknown,actorId:string,now:string):ColleagueReview {
  const value=colleagueReviewSchema.parse(current),command=colleagueReviewCommandSchema.parse(input);
  id.parse(actorId);z.string().datetime().parse(now);
  if(command.action==='create'||command.id!==value.id)throw new ColleagueReviewConflict('Запрос проверки не совпадает.');
  if(actorId!==(command.action==='respond'?value.recipientId:value.senderId))throw new ColleagueReviewForbidden('Это действие доступно другому участнику.');
  if(value.status!=='pending'||command.expectedStatusVersion!==value.statusVersion)throw new ColleagueReviewConflict('Запрос уже изменён. Обновите его состояние.');
  if(Date.parse(now)<Date.parse(value.createdAt))throw new ColleagueReviewConflict('Время действия предшествует запросу.');
  if(command.action==='cancel')return colleagueReviewSchema.parse({...value,status:'cancelled',statusVersion:value.statusVersion+1,cancellation:{actorId,at:now}});
  if(command.target.revision!==value.target.revision||command.target.documentHash!==value.target.documentHash)
    throw new ColleagueReviewConflict('Ответ относится к другой версии презентации.');
  return colleagueReviewSchema.parse({...value,status:'responded',statusVersion:value.statusVersion+1,response:{actorId,at:now,outcome:command.outcome,note:command.note}});
}
