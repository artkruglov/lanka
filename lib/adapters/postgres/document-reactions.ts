import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {BrowserPrincipal} from '../../server/browser-identity';
import {OrganizationAccessError} from '../../server/organization-access';
import {canonicalJson} from '../../domain/canonical-json';
import {PostgresResourceAccess} from './resource-access';
export async function reactionsIn(c:PoolClient,tenant:string,material:string,actor:string){
 const r=await c.query(`SELECT count(*) FILTER(WHERE kind='like')::int AS likes,
  coalesce(bool_or(principal_id=$3 AND kind='like'),false) AS liked,
  coalesce(bool_or(principal_id=$3 AND kind='bookmark'),false) AS bookmarked
  FROM lanka.document_reactions WHERE tenant_id=$1 AND material_id=$2`,[tenant,material,actor]);return r.rows[0] as {likes:number;liked:boolean;bookmarked:boolean};
}
export class DocumentReactions {
 constructor(private resources:PostgresResourceAccess){}
 read(p:BrowserPrincipal,tenant:string,material:string){if(p.kind!=='oidc')throw new OrganizationAccessError(403);return this.resources.withMaterial(p,tenant,material,'viewer',(c,ctx)=>reactionsIn(c,tenant,material,ctx.principalId));}
 set(p:BrowserPrincipal,tenant:string,material:string,input:unknown){
  if(p.kind!=='oidc')throw new OrganizationAccessError(403);
  const request=z.object({requestId:z.string().uuid(),kind:z.enum(['like','bookmark']),active:z.boolean()}).strict().parse(input);
  return this.resources.withMaterial(p,tenant,material,'viewer',async(c,ctx)=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tenant+':reactions:'+ctx.principalId]);
   const fingerprint=createHash('sha256').update(canonicalJson({material,...request})).digest('hex');
   const prior=await c.query('SELECT fingerprint,result FROM lanka.document_reaction_receipts WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3',[tenant,ctx.principalId,request.requestId]);
   if(prior.rowCount){if(prior.rows[0].fingerprint!==fingerprint)throw new OrganizationAccessError(409,'Ключ повтора использован для другой реакции.');return prior.rows[0].result;}
   if(request.active)await c.query('INSERT INTO lanka.document_reactions(tenant_id,material_id,principal_id,kind) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[tenant,material,ctx.principalId,request.kind]);
   else await c.query('DELETE FROM lanka.document_reactions WHERE tenant_id=$1 AND material_id=$2 AND principal_id=$3 AND kind=$4',[tenant,material,ctx.principalId,request.kind]);
   const result=await reactionsIn(c,tenant,material,ctx.principalId);
   await c.query('INSERT INTO lanka.document_reaction_receipts(tenant_id,principal_id,request_id,material_id,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6)',[tenant,ctx.principalId,request.requestId,material,fingerprint,JSON.stringify(result)]);return result;
  });
 }
}
