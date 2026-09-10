import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {z} from 'zod';
import {pdfFontFiles} from '../domain/scene-typography';
const entry=z.object({file:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),byteLength:z.number().int().positive()}).strict();
const snapshotSchema=z.object({format:z.literal('lanka-design-fonts/v1'),profile:z.enum(['focus-v2','focus-v3']),files:z.array(entry).max(5)}).strict();
export type DesignFontSnapshot=z.infer<typeof snapshotSchema>;
const files=(profile:DesignFontSnapshot['profile'])=>[...pdfFontFiles(profile),...(profile==='focus-v3'?['OFL-IBMPlexSans.txt','OFL-IBMPlexMono.txt']:['LICENSE.txt'])];
const fontRoot=()=>resolve(import.meta.dirname,'../public/fonts');
/** Record bytes, not a family-name promise. Licensing files are dependencies too. */
export async function captureDesignFonts(profile:DesignFontSnapshot['profile']):Promise<DesignFontSnapshot>{
 return {format:'lanka-design-fonts/v1',profile,files:await Promise.all(files(profile).map(async file=>{
  const bytes=await readFile(resolve(fontRoot(),file));
  return {file,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 }))};
}
export async function verifyDesignFonts(value:unknown,profile:DesignFontSnapshot['profile']){
 const snapshot=snapshotSchema.parse(value),expected=files(profile);
 if(snapshot.profile!==profile||snapshot.files.length!==expected.length||snapshot.files.some((entry,i)=>entry.file!==expected[i]))throw Error('Файлы шрифта вне выбранного дизайн-пакета.');
 const current=await captureDesignFonts(profile);
 if(snapshot.files.some((entry,i)=>entry.sha256!==current.files[i].sha256||entry.byteLength!==current.files[i].byteLength))throw Error('Шрифты дизайн-пакета изменились после отправки поручения. Создайте новое поручение с текущим пакетом.');
}
