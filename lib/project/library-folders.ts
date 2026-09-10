export type LibraryFolder={id:string;name:string;parentId?:string|null};
/** Stable depth-first order and full labels for folders with identical names. Legacy flat lists remain valid. */
export function folderTree<T extends LibraryFolder>(folders:T[]):(T&{depth:number;path:string;ancestors:string[]})[]{
 const byId=new Map(folders.map(f=>[f.id,f])),children=new Map<string|null,T[]>();
 for(const folder of folders){const seen=new Set([folder.id]);let parent=folder.parentId?byId.get(folder.parentId):undefined,valid=true;
  while(parent){if(seen.has(parent.id)||seen.size>65){valid=false;break;}seen.add(parent.id);parent=parent.parentId?byId.get(parent.parentId):undefined;}
  const key=valid&&folder.parentId&&byId.has(folder.parentId)?folder.parentId:null;children.set(key,[...(children.get(key)??[]),folder]);
 }
 const result:(T&{depth:number;path:string;ancestors:string[]})[]=[],visited=new Set<string>();
 const walk=(parent:string|null,ancestors:string[],names:string[])=>{for(const f of (children.get(parent)??[]).sort((a,b)=>a.name.localeCompare(b.name,'ru')||a.id.localeCompare(b.id))){if(visited.has(f.id))continue;visited.add(f.id);result.push({...f,depth:ancestors.length,path:[...names,f.name].join(' / '),ancestors});walk(f.id,[...ancestors,f.id],[...names,f.name]);}};
 walk(null,[],[]);return result;
}
