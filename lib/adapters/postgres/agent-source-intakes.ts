import {z} from 'zod';
import {resolve} from 'node:path';
import type {CorporatePrincipal} from '../../server/agent-delegation';
import {OrganizationAccessError} from '../../server/organization-access';
import {ChatDatabase} from './chat-database';
import {PostgresOrganizationAccess} from './organization-access';
import {removeSourceIntake,extractSource,stageSourceIntake,listSourceIntakes,getSourceIntake,type SourceIntakeScope} from '../../agents/source-intake';
/** Reauthorize every short transaction, including persistence after the parser returns. */
export class AgentSourceIntakes {
 constructor(private organizations:PostgresOrganizationAccess,private runtimeRoot:string,private extract:typeof extractSource=extractSource){}
 private async using<T>(p:CorporatePrincipal,tenant:string,fn:(db:ChatDatabase,scope:SourceIntakeScope|undefined)=>Promise<T>,write=false){
  const initial=await this.organizations.withTenant(p,tenant,async(c,ctx)=>ctx,false,{workspace:true,capability:'create',write});
  const db=new ChatDatabase({connection:{},tenantId:tenant,ownerId:initial.principalId,runtimeRoot:resolve(this.runtimeRoot,tenant)},{pool:this.organizations.pool,run:change=>this.organizations.withTenant(p,tenant,async(c,ctx)=>{
   if(ctx.principalId!==initial.principalId)throw new OrganizationAccessError(403);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tenant+':'+ctx.principalId]);return change(c);
  },false,{workspace:true,capability:'create',write})});
  try{return await fn(db,p.kind==='delegated'?{delegationHash:p.tokenHash}:undefined);}
  catch(e){if(e instanceof OrganizationAccessError)throw e;if(e instanceof Error&&/^(Файл недоступен)/.test(e.message))throw new OrganizationAccessError(404,e.message);if(e instanceof Error&&/^(Поддерживаются PDF|Файл повреждён|Текстовый файл превышает|Ключ загрузки|Достигнут лимит временных файлов|Материал изменился|Материал удалён|Сервер уже читает)/.test(e.message))throw new OrganizationAccessError(409,e.message);throw e;}
 }
 upload(p:CorporatePrincipal,tenant:string,input:unknown){return this.using(p,tenant,(db,scope)=>stageSourceIntake(db,input,this.extract,scope),true);}
 list(p:CorporatePrincipal,tenant:string){return this.using(p,tenant,(db,scope)=>listSourceIntakes(db,scope));}
 remove(p:CorporatePrincipal,tenant:string,input:unknown){
  if(p.kind==='delegated')throw new OrganizationAccessError(403,'Удалять подготовку может только владелец.');
  const a=z.object({id:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(input);
  return this.using(p,tenant,db=>removeSourceIntake(db,a.id,a.sha256));
 }
 read(p:CorporatePrincipal,tenant:string,id:string){return this.using(p,tenant,(db,scope)=>getSourceIntake(db,id,scope));}
}
