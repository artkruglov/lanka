import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonicalJson} from '../domain/canonical-json';

const sha=z.string().regex(/^[a-f0-9]{64}$/);
type Json=null|boolean|number|string|Json[]|{[key:string]:Json};
const json:z.ZodType<Json>=z.lazy(()=>z.union([z.null(),z.boolean(),z.number().finite(),z.string(),z.array(json),z.record(json)]));
const asset=z.object({
 path:z.string().min(1).max(240).regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.[a-zA-Z0-9]+$/),
 role:z.enum(['font','license','reference','renderer']),
 sha256:sha,byteLength:z.number().int().positive().max(64*1024*1024),
}).strict();
export const manifestBodySchema=z.object({
 format:z.literal('lanka-design-package/v1'),
 profile:z.enum(['focus-v2','focus-v3']),
 componentSchema:z.string().min(1).max(100),
 renderer:z.object({entry:asset.shape.path,buildSha256:sha}).strict(),
 rules:z.record(json),
 assets:z.array(asset).min(1).max(128),
}).strict().superRefine((value,ctx)=>{
 const paths=value.assets.map(a=>a.path);
 if(new Set(paths).size!==paths.length)ctx.addIssue({code:'custom',message:'Duplicate package asset path'});
 const entry=value.assets.find(a=>a.path===value.renderer.entry);
 if(!entry||entry.role!=='renderer'||entry.sha256!==value.renderer.buildSha256)ctx.addIssue({code:'custom',message:'Renderer entry must identify a captured renderer asset'});
 for(const role of ['font','license'] as const)if(!value.assets.some(a=>a.role===role))ctx.addIssue({code:'custom',message:`Missing ${role} assets`});
});
export type DesignPackageBody=z.infer<typeof manifestBodySchema>;
export type DesignPackageManifest=DesignPackageBody & {digest:string};
export const bytesDigest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');

/** Asset enumeration order is not identity; rule arrays remain semantically ordered. */
export function createManifest(input:unknown):DesignPackageManifest {
 const parsed=manifestBodySchema.parse(input);
 const body={...parsed,assets:[...parsed.assets].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)};
 return {...body,digest:bytesDigest(canonicalJson(body))};
}
export function readManifest(input:unknown):DesignPackageManifest {
 const envelope=z.object({digest:sha}).passthrough().parse(input);
 const {digest,...body}=envelope,manifest=createManifest(body);
 if(manifest.digest!==digest)throw Error('Design package manifest digest mismatch');
 return manifest;
}
/** Validate all bytes before a store publishes a package. Never resolve host paths here. */
export function verifyPackage(input:unknown,blobs:ReadonlyMap<string,Uint8Array>):DesignPackageManifest {
 const manifest=readManifest(input);
 if(blobs.size!==manifest.assets.length)throw Error('Design package asset set mismatch');
 for(const asset of manifest.assets){
  const bytes=blobs.get(asset.path);
  if(!bytes||bytes.byteLength!==asset.byteLength||bytesDigest(bytes)!==asset.sha256)throw Error(`Design package asset mismatch: ${asset.path}`);
 }
 return manifest;
}
