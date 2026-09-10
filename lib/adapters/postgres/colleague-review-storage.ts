import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {canonicalJson} from '../../domain/canonical-json';
import {colleagueReviewCommandSchema,colleagueReviewSchema,createColleagueReview,transitionColleagueReview,ColleagueReviewConflict,type ColleagueReview} from '../../domain/colleague-review';
const id=z.string().uuid();
/** Internal transactional storage, not an authorization API. The caller owns BEGIN/COMMIT
 * and must authorize current tenant membership, document ACL and the shared version
 * before calling (including retries). Never expose this function directly to HTTP/MCP.
 */
export async function writeColleagueReviewIn(c:PoolClient,context:{tenantId:string;documentId:string;actorId:string},input:unknown):Promise<ColleagueReview>{
 const tenant=id.parse(context.tenantId),material=id.parse(context.documentId),actor=id.parse(context.actorId);
 const command=colleagueReviewCommandSchema.parse(input);
 const fingerprint=createHash('sha256').update(canonicalJson({material,command})).digest('hex');
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${tenant}:${actor}:colleague-review:${command.requestId}`]);
 const prior=(await c.query('SELECT fingerprint,result FROM lanka.colleague_review_receipts WHERE tenant_id=$1 AND actor_id=$2 AND request_id=$3',[tenant,actor,command.requestId])).rows[0];
 if(prior){if(prior.fingerprint!==fingerprint)throw new ColleagueReviewConflict('Повторный запрос содержит другие данные.');return colleagueReviewSchema.parse(prior.result);}
 let next:ColleagueReview;
 if(command.action==='create'){
  next=createColleagueReview(command,{id:randomUUID(),tenantId:tenant,documentId:material,senderId:actor,now:new Date().toISOString()});
  await c.query('INSERT INTO lanka.colleague_reviews(tenant_id,id,material_id,revision,document_hash,sender_id,recipient_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[tenant,next.id,material,next.target.revision,next.target.documentHash,actor,next.recipientId,JSON.stringify(next)]);
 }else{
  const row=(await c.query('SELECT state FROM lanka.colleague_reviews WHERE tenant_id=$1 AND material_id=$2 AND id=$3 FOR UPDATE',[tenant,material,command.id])).rows[0];
  if(!row)throw new ColleagueReviewConflict('Запрос проверки недоступен.');
  next=transitionColleagueReview(colleagueReviewSchema.parse(row.state),command,actor,new Date().toISOString());
  await c.query('UPDATE lanka.colleague_reviews SET state=$4 WHERE tenant_id=$1 AND material_id=$2 AND id=$3',[tenant,material,next.id,JSON.stringify(next)]);
 }
 await c.query('INSERT INTO lanka.colleague_review_receipts(tenant_id,actor_id,request_id,review_id,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6)',[tenant,actor,command.requestId,next.id,fingerprint,JSON.stringify(next)]);
 return next;
}
