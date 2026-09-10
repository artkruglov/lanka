export type BrowserContext={userId:string;tenantId:string|null;documentId:string|null};
const uuid='[a-f0-9-]{36}';
export function corporateContext():BrowserContext|null {
 if(typeof document==='undefined'||document.body?.dataset.auth!=='oidc')return null;
 const userId=document.body.dataset.userId;
 if(!userId||!new RegExp('^'+uuid+'$').test(userId))throw Error('Отсутствует контекст пользователя.');
 const route=location.pathname.match(new RegExp('^/organizations/('+uuid+')(?:/documents/('+uuid+'))?$'));
 return {userId,tenantId:route?.[1]??null,documentId:route?.[2]??null};
}
export function scopedApiPath(path:string,ctx:BrowserContext|null=corporateContext()) {
 if(!ctx)return path;
 if(path==='/api/organizations')return path;
 if(!ctx.tenantId)throw Error('Сначала выберите организацию.');
 const u=new URL(path,'https://lanka.invalid'),base=`/api/organizations/${ctx.tenantId}`;
 if(u.pathname==='/api/review-inbox')return base+'/review-inbox'+u.search;
 if(['/api/folder-sharing','/api/folder-sharing-subjects'].includes(u.pathname)){
  const resource=u.searchParams.get('resourceId');if(!resource||!new RegExp('^'+uuid+'$').test(resource))throw Error('Выберите папку.');
  return base+u.pathname.slice(4)+u.search;
 }
 if(new RegExp('^/api/(?:review-recipients|review-requests(?:/'+uuid+'(?:/(?:version|assets))?)?)$').test(u.pathname)){
  if(!ctx.documentId)throw Error('Выберите документ.');
  return base+'/documents/'+ctx.documentId+u.pathname.slice(4)+u.search;
 }
 if(new RegExp('^/api/publications(?:/'+uuid+'(?:/artifacts)?)?$').test(u.pathname)){
  if(!ctx.documentId)throw Error('Выберите документ.');
  return base+'/documents/'+ctx.documentId+u.pathname.slice(4)+u.search;
 }
 if(new RegExp('^/api/conversations(?:/'+uuid+')?$').test(u.pathname))return base+u.pathname.slice(4)+u.search;
 if(u.pathname==='/api/members')return base+'/members'+u.search;
 if(u.pathname==='/api/shared-create')return base+'/shared-create';
 if(u.pathname==='/api/library')return base+'/library'+u.search;
 if(u.pathname==='/api/workspace-source-intakes')return base+'/source-intakes'+u.search;
 if(u.pathname==='/api/workspace-delegations')return base+'/agent-delegations'+u.search;
 if(u.pathname==='/api/publication-catalog')return base+'/publication-catalog'+u.search;
 if(u.pathname==='/api/shared-library')return base+'/shared-library'+u.search;
 const routes:Record<string,string>={'/api/cover':'/cover','/api/reactions':'/reactions','/api/project':'','/api/images':'/images','/api/assets':'/assets','/api/sources':'/sources','/api/history':'/history','/api/export':'/export','/api/export-artifacts':'/exports','/api/document-copy':'/copy','/api/view':'/view','/api/view-assets':'/view-assets','/api/agent-delegations':'/agent-delegations','/api/shared-comments':'/shared-comments','/api/sharing':'/sharing','/api/sharing-subjects':'/sharing-subjects'};
 const id=u.searchParams.get('documentId')??ctx.documentId;
 if(routes[u.pathname]===undefined||!id||!new RegExp('^'+uuid+'$').test(id))throw Error('Эта операция недоступна в организации.');
 u.searchParams.delete('documentId');return base+'/documents/'+id+routes[u.pathname]+u.search;
}
export const libraryPath=()=>{const c=corporateContext();return c?.tenantId?`/organizations/${c.tenantId}`:'/';};
export const documentPath=(id:string)=>corporateContext()?libraryPath()+'/documents/'+id:'/documents/'+id;
export const browserDatabaseName=(name:string)=>{const c=corporateContext();return c?`${name}:${c.userId}:${c.tenantId??'home'}`:name;};
/** Scope application reads/writes; this is not encryption against a user controlling the browser. */
export function scopedStorage(storage:Storage,ctx:BrowserContext|null=corporateContext()):Storage {
 if(!ctx)return storage;
 const prefix=`lanka-scope:${ctx.userId}:${ctx.tenantId??'home'}:`;
 const keys=()=>Array.from({length:storage.length},(_,i)=>storage.key(i)).filter((k):k is string=>!!k&&k.startsWith(prefix));
 return {get length(){return keys().length;},key(i){return keys()[i]?.slice(prefix.length)??null;},getItem(k){return storage.getItem(prefix+k);},setItem(k,v){storage.setItem(prefix+k,v);},removeItem(k){storage.removeItem(prefix+k);},clear(){keys().forEach(k=>storage.removeItem(k));}};
}
