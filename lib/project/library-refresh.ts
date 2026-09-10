/** Re-read the loaded page window so removals, moves and external edits replace stale entries. */
export async function readLibraryWindow<T extends {documents:{id:string}[];nextCursor?:string|null}>(load:(cursor?:string)=>Promise<T>,pages:number):Promise<T>{
 let result=await load(),cursor=result.nextCursor;const seen=new Set<string>();
 for(let page=1;page<pages&&cursor;page++){
  if(seen.has(cursor))throw Error('Не удалось обновить список: повтор страницы.');seen.add(cursor);
  const next=await load(cursor),ids=new Set(result.documents.map(d=>d.id));
  result={...next,documents:[...result.documents,...next.documents.filter(d=>!ids.has(d.id))]};cursor=next.nextCursor;
 }
 return result;
}
