/** Export original backup bytes, including fields a newer schema cannot interpret. */
export function editorUpgradeBackups(storage:Pick<Storage,'getItem'|'key'|'length'>|null,documentId:string){
 const items:{key:string;raw:string;title:string;updatedAt:number;revision:number|null}[]=[];
 if(!storage)return {items,unavailable:true};
 try{for(let i=0;i<storage.length;i++){
   const key=storage.key(i);if(!key?.startsWith(`lanka:editor-upgrade-backup:v1:${documentId}:`))continue;
   const raw=storage.getItem(key);if(raw===null)continue;
   let title='Копия черновика',updatedAt=0,revision:number|null=null;
   try{
     const v=JSON.parse(raw);
     if(v?.doc?.id!==documentId||v?.base?.doc?.id!==documentId)continue;
     if(typeof v.doc.title==='string')title=v.doc.title;
     if(Number.isFinite(v.updatedAt)&&v.updatedAt>0&&v.updatedAt<=8.64e15)updatedAt=v.updatedAt;
     if(Number.isSafeInteger(v.base.revision)&&v.base.revision>0)revision=v.base.revision;
   }catch{/* A damaged backup remains downloadable for recovery. */}
   items.push({key,raw,title,updatedAt,revision});
 }}catch{return {items,unavailable:true};}
 return {items:items.sort((a,b)=>b.updatedAt-a.updatedAt||a.key.localeCompare(b.key)),unavailable:false};
}
