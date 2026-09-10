import {createHash} from 'node:crypto';
import type {ProjectRepository} from './repository';
import {materialPath} from './package';

/** Repository authorizes the document; only registered, verified original bytes leave it. */
export async function sourceDownload(repo:Pick<ProjectRepository,'read'|'readFile'>,id:string){
  const project=await repo.read();
  const source=project?.state.sources.find(s=>s.id===id);
  if(!source)throw Error('Документ недоступен.');
  const bytes=await repo.readFile(materialPath(source.sha256));
  if(createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw Error('Source hash mismatch');
  const name=encodeURIComponent(source.name.toWellFormed().replace(/[\x00-\x1f\x7f/\\]/g,'_')).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
  return {bytes,headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="source"; filename*=UTF-8''${name}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'}};
}
