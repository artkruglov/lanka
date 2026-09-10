/** npm repeats package identities for multiple install paths. Retain paths and union graph edges. */
export function normalizeNpmSbom(input){
 const bom=structuredClone(input),components=new Map(),dependencies=new Map();
 const union=(a=[],b=[])=>[...new Map([...a,...b].map(v=>[JSON.stringify(v),v])).values()];
 for(const c of bom.components){
  const previous=components.get(c['bom-ref']);if(!previous){components.set(c['bom-ref'],c);continue;}
  const identity=v=>{const {properties,scope,externalReferences,hashes,...rest}=v;return JSON.stringify(rest);};
  if(identity(previous)!==identity(c))throw Error('Conflicting package identity: '+c['bom-ref']);
  const hashes=union(previous.hashes,c.hashes),algorithms=new Map();
  for(const h of hashes){if(algorithms.has(h.alg)&&algorithms.get(h.alg)!==h.content)throw Error('Conflicting package hash: '+c['bom-ref']);algorithms.set(h.alg,h.content);}
  previous.properties=union(previous.properties,c.properties);previous.externalReferences=union(previous.externalReferences,c.externalReferences);previous.hashes=hashes;
  const rank={required:0,optional:1,excluded:2};previous.scope=(rank[previous.scope??'required']<=rank[c.scope??'required'])?(previous.scope??'required'):(c.scope??'required');
 }
 for(const d of bom.dependencies){const prior=dependencies.get(d.ref);if(prior)prior.dependsOn=[...new Set([...(prior.dependsOn??[]),...(d.dependsOn??[])])];else dependencies.set(d.ref,d);}
 bom.components=[...components.values()];bom.dependencies=[...dependencies.values()];return bom;
}
