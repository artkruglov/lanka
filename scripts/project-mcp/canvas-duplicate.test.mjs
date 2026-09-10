import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import JSZip from 'jszip';
await build({stdin:{contents:`export {duplicateCanvasElement} from './lib/domain/canvas-duplicate';export {initialDataPlacement} from './lib/domain/data-layout';export {exportCapabilities} from './lib/project/export-capabilities';export {pptxBytes} from './lib/export';export {demoDoc,canvasSchema} from './lib/domain/model';`,resolveDir:process.cwd()},outfile:'.project-runtime/canvas-duplicate-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {duplicateCanvasElement,pptxBytes,demoDoc,canvasSchema,initialDataPlacement,exportCapabilities}=await import('../../.project-runtime/canvas-duplicate-test.mjs');
const rect=(id,extra={})=>({id,kind:'rect',x:100,y:100,w:300,h:100,color:'#123456',...extra});
test('duplicate detaches template title without moving locked layers or mutating source',()=>{
 const title={...rect('title'),kind:'text',text:'Title',size:40,lineHeight:1.3,bold:true,sourceField:'title',font:'sans'};
 const input=[rect('bg',{locked:true}),title,rect('anchor',{locked:true})],before=structuredClone(input),next=duplicateCanvasElement(input,'title','copy');
 assert.deepEqual(input,before);assert.deepEqual(next.slice(0,3),input);assert.equal(next[3].id,'copy');assert.equal(next[3].x,124);assert.equal(next[3].y,124);assert.equal(next[3].sourceField,undefined);assert.equal(next[3].font,'sans');
});
test('copies nested chart data independently and clamps at slide boundaries',()=>{
 const chart={...rect('chart'),kind:'chart',x:1300,y:800,data:{rows:[{id:'row',value:30}]}};const next=duplicateCanvasElement([chart],'chart','copy');next[1].data.rows[0].value=40;assert.equal(chart.data.rows[0].value,30);assert.equal(next[1].x,1300);assert.equal(next[1].y,800);
});
test('rejects locked, missing, duplicate ID and capacity without changes',()=>{
 assert.equal(duplicateCanvasElement([rect('a',{locked:true})],'a','b'),null);assert.equal(duplicateCanvasElement([rect('a')],'missing','b'),null);assert.equal(duplicateCanvasElement([rect('a')],'a','a'),null);assert.equal(duplicateCanvasElement(Array.from({length:240},(_,i)=>rect(String(i))),'0','copy'),null);
});

for(const kind of ['chart','table'])test(`duplicated ${kind} retains independent native objects and data in exported PPTX`,async()=>{
 const doc=demoDoc();doc.design='focus-v3';const style={design:'focus-v3',brand:doc.brand};
 const data=kind==='chart'?{seriesId:'series',unit:'',rows:[{id:'row-a',label:'A',value:20},{id:'row-b',label:'B',value:40}]}:{columns:[{id:'name',label:'Name',role:'key',valueType:'text',unit:''},{id:'value',label:'Value',role:'number',valueType:'number',unit:''}],rows:[{id:'row-a',cells:{name:'A',value:20}},{id:'row-b',cells:{name:'B',value:40}}]};
 const original=initialDataPlacement({id:'original',kind,x:100,y:200,w:1280,h:350,style,data},[]);assert.ok(original,'UI placement must produce a readable data object');
 const canvas=duplicateCanvasElement([original],'original','copy');
 if(kind==='chart')canvas[1].data.rows[0].value=77;else canvas[1].data.rows[0].cells.value=77;
 assert.equal(kind==='chart'?original.data.rows[0].value:original.data.rows[0].cells.value,20);
 canvasSchema.parse(canvas);doc.slides=[{...doc.slides[0],canvas}];const report=exportCapabilities(doc,'pptx');assert.equal(report.slides[0].objects.filter(o=>o.representation==='native-'+kind).length,2);assert.deepEqual(report.slides[0].objects.filter(o=>o.kind===kind).map(o=>o.objectId),['original','copy']);
 const zip=await JSZip.loadAsync(await pptxBytes(doc,[],async()=>{throw Error('Unexpected asset read');})),xml=await zip.file('ppt/slides/slide1.xml').async('string');
 if(kind==='table'){
  assert.equal((xml.match(/<a:tbl>/g)||[]).length,2);const tables=xml.match(/<a:tbl>[\s\S]*?<\/a:tbl>/g);assert.match(tables[0],/<a:t>20<\/a:t>/);assert.doesNotMatch(tables[0],/<a:t>77<\/a:t>/);assert.match(tables[1],/<a:t>77<\/a:t>/);
 }else{
  const charts=Object.keys(zip.files).filter(p=>/^ppt\/charts\/chart\d+\.xml$/.test(p));assert.equal(charts.length,2);
  const xmls=await Promise.all(charts.map(p=>zip.file(p).async('string')));assert.ok(xmls.some(s=>s.includes('<c:v>20</c:v>')&&!s.includes('<c:v>77</c:v>')));assert.ok(xmls.some(s=>s.includes('<c:v>77</c:v>')));
  const books=Object.keys(zip.files).filter(p=>/^ppt\/embeddings\/.*\.xlsx$/.test(p));assert.equal(books.length,2);
  const sheets=await Promise.all(books.map(async p=>{const book=await JSZip.loadAsync(await zip.file(p).async('nodebuffer'));return book.file('xl/worksheets/sheet1.xml').async('string');}));
  assert.ok(sheets.some(s=>s.includes('<v>20</v>')&&!s.includes('<v>77</v>')));assert.ok(sheets.some(s=>s.includes('<v>77</v>')));

 }
});
