import type {PoolClient} from 'pg';
import {resolve} from 'node:path';
import {ChatDatabase} from './chat-database';
import type {DatabasePool} from './database-pool';
import type {OrganizationContext} from '../../server/organization-access';

/** Reuses document persistence on the caller's authorized transaction. No second pool, BEGIN or COMMIT. */
export async function usingTransactionDatabase<T>(c:PoolClient,context:OrganizationContext,runtimeRoot:string,fn:(db:ChatDatabase)=>Promise<T>) {
 let active=true;
 const check=()=>{if(!active)throw Error('Document transaction has ended.');};
 const query=((...args:unknown[])=>{check();return Reflect.apply(c.query,c,args);}) as DatabasePool['query'];
 const pool:DatabasePool={query,connect(){throw Error('A transaction view cannot borrow a connection.');},end(){throw Error('A transaction view cannot close its connection.');}};
 const db=new ChatDatabase({connection:{},tenantId:context.tenantId,ownerId:context.principalId,runtimeRoot:resolve(runtimeRoot,context.tenantId)},{pool,async run(change){
  check();await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[context.tenantId+':'+context.principalId]);
  return change(c);
 }});
 try{return await fn(db);}finally{active=false;}
}
