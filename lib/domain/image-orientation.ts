/** Browsers orient JPEGs using EXIF; PDF and Office decoders may not. Do not
 * silently export a different crop until the asset pipeline normalizes these. */
export function assertUprightImage(bytes:ArrayBuffer,type:string){
 if(type!=='image/jpeg')return;
 const v=new DataView(bytes);let p=2;
 while(p+4<=v.byteLength&&v.getUint8(p)===255){
   const marker=v.getUint8(p+1);if(marker===0xda||marker===0xd9)return;
   const length=v.getUint16(p+2);if(length<2||p+2+length>v.byteLength)return;
   if(marker===0xe1&&length>=16&&v.getUint32(p+4)===0x45786966&&v.getUint16(p+8)===0){
     const start=p+10,end=p+2+length,little=v.getUint16(start)===0x4949;
     if(!little&&v.getUint16(start)!==0x4d4d)return;
     const ifd=start+v.getUint32(start+4,little);if(ifd<start||ifd+2>end)return;
     const count=v.getUint16(ifd,little);
     for(let i=0;i<count;i++){
       const entry=ifd+2+i*12;if(entry+12>end)return;
       if(v.getUint16(entry,little)===0x112&&v.getUint16(entry+2,little)===3&&v.getUint32(entry+4,little)===1){
         const orientation=v.getUint16(entry+8,little);
         if(orientation!==1)throw Error('Источник содержит поворот EXIF. Загрузите его через «Заменить файлом»: Lanka обработает ориентацию автоматически.');
       }
     }
   }
   p+=2+length;
 }
}
