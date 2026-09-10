import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
await build({entryPoints:['lib/domain/canvas-align.ts'],outfile:'.project-runtime/canvas-align-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {alignCanvasElement}=await import('../../.project-runtime/canvas-align-test.mjs');
test('six slide alignments only change the requested position and preserve image crop',()=>{
 const original={id:'photo',kind:'image',assetId:'image-source',x:130,y:180,w:950,h:190,frame:{fit:'cover',focusX:.3,focusY:.8}};
 const snapshot=structuredClone(original);
 for(const [direction,position] of Object.entries({left:{x:0},center:{x:325},right:{x:650},top:{y:0},middle:{y:355},bottom:{y:710}})){
   const result=alignCanvasElement(original,direction);
   assert.deepEqual(result,{...snapshot,...position});
   assert.strictEqual(alignCanvasElement(result,direction),result);
 }
 assert.deepEqual(original,snapshot);
 assert.strictEqual(alignCanvasElement(original,'invalid'),original);
 const locked={...original,locked:true};assert.strictEqual(alignCanvasElement(locked,'center'),locked);
});

await build({stdin:{contents:`export {compileCommands} from './lib/domain/commands';export {assertSelectionChanges} from './lib/domain/selection-changes';export {demoDoc} from './lib/domain/model';`,resolveDir:process.cwd()},outfile:'.project-runtime/canvas-align-command-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {compileCommands,assertSelectionChanges,demoDoc}=await import('../../.project-runtime/canvas-align-command-test.mjs');
test('alignment proposal preserves neighbours and respects selection and template locks',()=>{
 const doc=demoDoc(),slide=doc.slides[0];
 const rect=(id,x)=>({id,kind:'rect',x,y:100,w:300,h:100,color:'#123456'});
 slide.canvas=[{...rect('bg',0),y:0,w:1600,h:900,locked:true},rect('selected',100),rect('neighbour',500)];
 const original=structuredClone(doc),command={op:'align_element',slideId:slide.id,elementId:'selected',direction:'center'};
 const changes=compileCommands(doc,[command]);assert.deepEqual(doc,original);
 assert.deepEqual(changes[0].after.canvas,slide.canvas.map(e=>e.id==='selected'?{...e,x:650}:e));
 assert.doesNotThrow(()=>assertSelectionChanges(doc,changes,{slideId:slide.id,elementId:'selected'}));
 assert.throws(()=>assertSelectionChanges(doc,changes,{slideId:slide.id,elementId:'neighbour'}));
 for(const patch of [{elementId:'bg'},{elementId:'missing'},{direction:'invalid'}])assert.throws(()=>compileCommands(doc,[{...command,...patch}]));
 delete slide.canvas;assert.throws(()=>compileCommands(doc,[command]),/template/);
});
