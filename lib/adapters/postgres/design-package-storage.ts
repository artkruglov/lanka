import type {PoolClient} from 'pg';
import {z} from 'zod';
import {verifyPackage,readManifest,type DesignPackageManifest} from '../../design-packages/manifest';
const tenantSchema=z.string().uuid(),digestSchema=z.string().regex(/^[a-f0-9]{64}$/);
/** Internal storage: caller owns the authorised tenant transaction. No public upload API. */
export async function saveDesignPackageIn(c:PoolClient,tenant:string,input:unknown,blobs:ReadonlyMap<string,Uint8Array>):Promise<DesignPackageManifest>{
 tenantSchema.parse(tenant);
 // Own the buffers before the first await; callers cannot mutate bytes after validation.
 const owned=new Map([...blobs].map(([path,bytes])=>[path,Buffer.from(bytes)]));
 const manifest=verifyPackage(input,owned);
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`design-package:${tenant}:${manifest.digest}`]);
 const old=await loadDesignPackageIn(c,tenant,manifest.digest);
 if(old)return old.manifest;
 await c.query('INSERT INTO lanka.design_packages(tenant_id,digest,manifest) VALUES($1,$2,$3)',[tenant,manifest.digest,JSON.stringify(manifest)]);
 for(const [path,bytes] of owned)await c.query('INSERT INTO lanka.design_package_assets(tenant_id,package_digest,path,bytes) VALUES($1,$2,$3,$4)',[tenant,manifest.digest,path,bytes]);
 return manifest;
}
export async function loadDesignPackageIn(c:PoolClient,tenant:string,digest:string){
 tenantSchema.parse(tenant);digestSchema.parse(digest);
 const result=await c.query('SELECT manifest FROM lanka.design_packages WHERE tenant_id=$1 AND digest=$2',[tenant,digest]);
 if(!result.rowCount)return null;
 const manifest=readManifest(result.rows[0].manifest);
 const rows=await c.query('SELECT path,bytes FROM lanka.design_package_assets WHERE tenant_id=$1 AND package_digest=$2',[tenant,digest]);
 const blobs=new Map<string,Uint8Array>(rows.rows.map(row=>[row.path,row.bytes]));
 verifyPackage(manifest,blobs);
 return {manifest,blobs};
}
