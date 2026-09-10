import type {PoolClient} from 'pg';
import {z} from 'zod';
import {resolveDesignPackageIn} from './design-package-resolver';
const targetSchema=z.object({documentId:z.string().uuid(),revision:z.number().int().positive(),documentHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type Target=z.infer<typeof targetSchema>;
/** Caller owns the authorised document transaction; a pin is part of a new revision save. */
export async function bindRevisionDesignIn(c:PoolClient,tenant:string,target:Target,digest:string){
 z.string().uuid().parse(tenant);target=targetSchema.parse(target);
 const revision=await c.query('SELECT doc FROM lanka.material_revisions WHERE tenant_id=$1 AND material_id=$2 AND revision=$3 AND hash=$4',[tenant,target.documentId,target.revision,target.documentHash]);
 if(!revision.rowCount)throw Error('Версия документа недоступна.');
 const profile=z.enum(['focus-v2','focus-v3']).parse(revision.rows[0].doc.design);
 await resolveDesignPackageIn(c,tenant,digest,profile);
 await c.query('INSERT INTO lanka.revision_design_packages(tenant_id,material_id,revision,document_hash,package_digest) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[tenant,target.documentId,target.revision,target.documentHash,digest]);
 const saved=await readRevisionDesignIn(c,tenant,target);
 if(saved!==digest)throw Error('Оформление сохранённой версии нельзя заменить.');
 return saved;
}
export async function readRevisionDesignIn(c:PoolClient,tenant:string,target:Target){
 z.string().uuid().parse(tenant);target=targetSchema.parse(target);
 const result=await c.query('SELECT package_digest FROM lanka.revision_design_packages WHERE tenant_id=$1 AND material_id=$2 AND revision=$3 AND document_hash=$4',[tenant,target.documentId,target.revision,target.documentHash]);
 return result.rows[0]?.package_digest as string|undefined;
}
