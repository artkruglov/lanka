import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';
await build({stdin:{contents:`export {applyCanvasDrag} from './lib/domain/canvas-drag';export {cancelCanvasTextSession} from './lib/domain/canvas-text-session';export {withCanvas} from './lib/domain/canvas';export {demoDoc} from './lib/domain/model';`,resolveDir:process.cwd()},outfile:'.project-runtime/canvas-text-session-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {applyCanvasDrag,cancelCanvasTextSession,withCanvas,demoDoc}=await import('../../.project-runtime/canvas-text-session-test.mjs');
test('Escape restores original template after our text write and preserves concurrent neighbour changes',()=>{
 const slide=demoDoc().slides[0],original={id:'text',kind:'text',x:100,y:100,w:900,h:100,text:'Original',size:40,bold:false,color:'#123456',lineHeight:1.2};
 const neighbour={id:'shape',kind:'rect',x:100,y:400,w:300,h:100,color:'#123456'};
 const objects=[original,neighbour],written={...original,text:'Changed',h:150},session={slide:structuredClone(slide),objects:structuredClone(objects),original,written};
 const current={...slide,...withCanvas(slide,[written,neighbour])};
 assert.deepEqual({...current,...cancelCanvasTextSession(current,current.canvas,session)},{...slide,canvas:undefined});
 const concurrent=structuredClone(current);concurrent.notes='New colleague notes';concurrent.canvas[1].x=500;
 const result=cancelCanvasTextSession(concurrent,concurrent.canvas,session);
 assert.equal(result.canvas[0].text,'Original');assert.equal(result.canvas[0].h,100);assert.equal(result.canvas[1].x,500);assert.equal({...concurrent,...result}.notes,'New colleague notes');
 concurrent.canvas[0].text='Colleague text';assert.equal(cancelCanvasTextSession(concurrent,concurrent.canvas,session),null);
 assert.equal(cancelCanvasTextSession({...current,id:'other'},current.canvas,session),null);
 assert.equal(cancelCanvasTextSession(current,current.canvas,{...session,written:undefined}),null);
 assert.equal(current.canvas[0].text,'Changed');
});

test('drag commits only geometry and preserves concurrent text, neighbours, additions and removals',()=>{
 const before={id:'text',kind:'text',x:100,y:100,w:900,h:100,text:'Original',size:40,bold:false,color:'#123456',lineHeight:1.2},after={...before,x:200,w:950};
 const neighbour={id:'new',kind:'rect',x:500,y:400,w:300,h:100,color:'#123456'};
 const current=[{...before,text:'Colleague content',color:'#ABCDEF'},neighbour],copy=structuredClone(current);
 const next=applyCanvasDrag(current,before,after);
 assert.deepEqual(next,[{...current[0],x:200,w:950},neighbour]);assert.deepEqual(current,copy);
 for(const target of [{...before,x:120},{...before,h:200},{...before,locked:true},{...neighbour,id:before.id}])assert.equal(applyCanvasDrag([target],before,after),null);
 assert.equal(applyCanvasDrag([],before,after),null);
});
test('crop refuses concurrent replacement or focal changes and move preserves a newer crop',()=>{
 const frame={fit:'cover',focusX:.5,focusY:.5,aspect:2},before={id:'image',kind:'image',x:100,y:100,w:400,h:300,assetId:'old',frame},after={...before,frame:{...frame,focusX:.2}};
 assert.equal(applyCanvasDrag([{...before,assetId:'new'}],before,after,true),null);
 const newer={...before,frame:{...frame,focusY:.1}};assert.equal(applyCanvasDrag([newer],before,after,true),null);
 assert.deepEqual(applyCanvasDrag([newer],before,{...before,x:200}),[{...newer,x:200}]);
 assert.deepEqual(applyCanvasDrag([before],before,after,true),[after]);
});

test('cancelling new text removes the insertion before or after input without erasing concurrent edits',()=>{
 const slide=demoDoc().slides[0],neighbour={id:'shape',kind:'rect',x:100,y:400,w:300,h:100,color:'#123456'},original={id:'new',kind:'text',x:100,y:100,w:600,h:180,text:'Новый текст',size:40,bold:false,color:'#123456',lineHeight:1.3};
 for(const written of [undefined,{...original,text:'Введённый текст'}]){
  const session={slide:structuredClone(slide),objects:[neighbour,original],original,added:true,written},current={...slide,...withCanvas(slide,[neighbour,written??original])};
  assert.deepEqual({...current,...cancelCanvasTextSession(current,current.canvas,session)},{...slide,canvas:undefined});
  const concurrent=structuredClone(current);concurrent.notes='Коллега сохранил заметку';concurrent.canvas[0].x=600;
  const patch=cancelCanvasTextSession(concurrent,concurrent.canvas,session);assert.deepEqual(patch.canvas,[concurrent.canvas[0]]);assert.equal({...concurrent,...patch}.notes,concurrent.notes);
  concurrent.canvas[1].text='Коллега отредактировал новый блок';assert.equal(cancelCanvasTextSession(concurrent,concurrent.canvas,session),null);
 }
});
