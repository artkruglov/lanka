import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import sharp from 'sharp';import 'fake-indexeddb/auto';
await build({stdin:{contents:'export {registerImage} from "./scripts/project-mcp/image-source";export {demoDoc,initialState} from "./lib/domain/model";export {imageUploadJournal,imageUploadRequest} from "./lib/project/image-upload";',resolveDir:process.cwd()},outfile:'.project-runtime/image-upload-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {registerImage,demoDoc,initialState,imageUploadJournal,imageUploadRequest}=await import('../../.project-runtime/image-upload-test.mjs');
const project=()=>({format:'lanka-project/v1',title:'Test',state:initialState(demoDoc()),receipts:[]});
const colors=[[255,0,0],[0,255,0],[0,0,255],[255,255,0]];
const input=Buffer.alloc(80*40*3);for(let y=0;y<40;y++)for(let x=0;x<80;x++)input.set(colors[(y>=20?2:0)+(x>=40?1:0)],(y*80+x)*3);
const expected=[[0,1,2,3],[1,0,3,2],[3,2,1,0],[2,3,0,1],[0,2,1,3],[2,0,3,1],[3,1,2,0],[1,3,0,2]];
test('all eight EXIF orientations normalize to the expected visible corners while preserving original bytes',async()=>{
 for(let orientation=1;orientation<=8;orientation++){
  const bytes=await sharp(input,{raw:{width:80,height:40,channels:3}}).jpeg({quality:100,chromaSubsampling:'4:4:4'}).withMetadata({orientation}).toBuffer(),p=project(),blobs=new Map();
  const store={writeMaterial:async b=>{const{createHash}=await import('node:crypto');const h=createHash('sha256').update(b).digest('hex');blobs.set(h,Buffer.from(b));return h;}};
  const args={name:'Photo.jpg',contentType:'image/jpeg',base64:bytes.toString('base64')};const result=await registerImage(store,p,args);
  assert.deepEqual(blobs.get(result.originalSha256),bytes);assert.equal(result.normalized,orientation!==1);
  const rendered=await sharp(blobs.get(result.sha256)).raw().toBuffer({resolveWithObject:true});const {width,height,channels}=rendered.info;
  assert.equal(width,orientation>=5?40:80);assert.equal(height,orientation>=5?80:40);assert.deepEqual(result.image,{width,height});
  for(let i=0;i<4;i++){const x=Math.floor(width*(i%2?.75:.25)),y=Math.floor(height*(i>=2?.75:.25)),offset=(y*width+x)*channels;for(let c=0;c<3;c++)assert.ok(Math.abs(rendered.data[offset+c]-colors[expected[orientation-1][i]][c])<12,`Orientation ${orientation}, corner ${i}`);}
  if(orientation!==1)assert.equal(p.state.sources.find(s=>s.id===result.originalSourceId).image.normalizedSourceId,result.sourceId);
  const repeated=await registerImage(store,p,args);assert.equal(repeated.sourceId,result.sourceId);assert.equal(p.state.sources.length,orientation===1?1:2);
 }
});
test('malformed and oversized decoded images fail before any material is written',async()=>{
 let writes=0;const store={writeMaterial:async()=>{writes++;return 'x';}};
 await assert.rejects(registerImage(store,project(),{name:'Wrong.png',contentType:'image/png',base64:Buffer.from('Not PNG').toString('base64')}),/PNG/);
 const large=await sharp({create:{width:6000,height:6000,channels:3,background:'white'}}).png().toBuffer();
 await assert.rejects(registerImage(store,project(),{name:'Large.png',contentType:'image/png',base64:large.toString('base64')}),/32 Мп/);
 assert.equal(writes,0);
});
test('upload journal persists photo-sized bytes, exact receipt and target across connections and isolates tabs',async()=>{
 const file=new File([Buffer.alloc(4_000_000,7)],'Photo.jpg',{type:'image/jpeg'}),target={deckId:'doc',expectedRevision:4,slideId:'slide',elementId:'picture'};
 const request=await imageUploadRequest(file,target);await imageUploadJournal('doc','tab-a','write',request);
 assert.deepEqual(await imageUploadJournal('doc','tab-a','read'),request);assert.equal(await imageUploadJournal('doc','tab-b','read'),null);assert.equal(await imageUploadJournal('other','tab-a','read'),null);
 await assert.rejects(imageUploadJournal('other','tab-a','write',request));
 await imageUploadJournal('doc','tab-a','delete');assert.equal(await imageUploadJournal('doc','tab-a','read'),null);
 await assert.rejects(imageUploadRequest(new File([Buffer.alloc(5_000_001)],'big.jpg',{type:'image/jpeg'}),target),/5 МБ/);
 await assert.rejects(imageUploadRequest(new File(['test'],'file.html',{type:'text/html'}),target),/PNG/);
});
