import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';
await build({stdin:{contents:`export {pendingObjects,mergeObjects,recordObjectDecisions} from './lib/domain/object-review';export {assertEditDesign} from './lib/agents/edit-design';export {compileCommands} from './lib/domain/commands';export {demoDoc} from './lib/domain/model';export {growTextBox,canvasScene} from './lib/domain/canvas';`,resolveDir:process.cwd()},outfile:'.project-runtime/canvas-text-test.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const {pendingObjects,mergeObjects,recordObjectDecisions,assertEditDesign,compileCommands,demoDoc,growTextBox,canvasScene}=await import('../../.project-runtime/canvas-text-test.mjs');
const base={id:'title',kind:'text',x:100,y:100,w:800,h:48,text:'Города и обмен',size:40,bold:false,color:'#20243B',font:'sans',lineHeight:1.2};
test('larger font expands a formerly fitting text box, retaining its position and content',()=>{
 const next={...base,size:80};assert.equal(canvasScene([next]).overflow,true);
 const fitted=growTextBox(next);assert.equal(canvasScene([fitted]).overflow,false);
 assert.ok(fitted.h>base.h);assert.deepEqual({...fitted,h:base.h},{...base,size:80});assert.equal(base.h,48);
});
test('bold wrapping and multiline input use the same growth rule; smaller text preserves the chosen box',()=>{
 const next=growTextBox({...base,w:280,bold:true,text:'Города и обмен\nПисьмо и знания'});
 assert.ok(next.h>base.h);assert.equal(canvasScene([next]).overflow,false);
 assert.equal(growTextBox({...next,size:20,text:'Город'}).h,next.h);
});
test('insufficient space keeps the top fixed and reports overflow instead of moving or shrinking text',()=>{
 const next=growTextBox({...base,y:860,h:40,size:80});assert.equal(next.y,860);assert.equal(next.h,40);assert.equal(next.size,80);
 assert.equal(canvasScene([next]).overflow,true);
});

test('edit_text preserves unrelated properties and neighbours in an unapplied proposal',()=>{
 const doc=demoDoc(),slide=doc.slides[0];slide.canvas=[{...base,sourceField:'title',tracking:0.02},{id:'shape',kind:'rect',x:120,y:500,w:100,h:100,color:'#000000'}];
 const before=structuredClone(doc);
 const [change]=compileCommands(doc,[{op:'edit_text',slideId:slide.id,elementId:base.id,value:{text:'Новый город',size:80,bold:true}}]);
 assert.deepEqual(doc,before);assert.equal(change.after.title,'Новый город');
 assert.deepEqual(change.after.canvas[0],growTextBox({...slide.canvas[0],text:'Новый город',size:80,bold:true}));
 assert.deepEqual(change.after.canvas[1],slide.canvas[1]);
});
test('edit_text rejects implicit template conversion, locked text, wrong types and non-text patch properties',()=>{
 const doc=demoDoc(),slide=doc.slides[0],command={op:'edit_text',slideId:slide.id,elementId:base.id,value:{size:80}};
 assert.throws(()=>compileCommands(doc,[command]),/template/);
 slide.canvas=[{...base,locked:true}];assert.throws(()=>compileCommands(doc,[command]),/locked/);
 slide.canvas=[{id:base.id,kind:'rect',x:100,y:100,w:100,h:100,color:'#000000'}];assert.throws(()=>compileCommands(doc,[command]),/another type/);
 slide.canvas=[base];for(const value of [{},{x:200},{text:'Hello',h:400},{size:241}])assert.throws(()=>compileCommands(doc,[{...command,value}]));
});

test('text proposals preserve previously stored locked pagination segments',()=>{
 const doc=demoDoc();doc.design='focus-v3';doc.slides=doc.slides.slice(0,1);const slide=doc.slides[0];
 slide.canvas=[{id:'old-segment',kind:'rect',x:1400,y:60,w:28,h:3,color:'#444BE8',locked:true,binding:'focus-v3-pagination'}, {...base}];
 const changes=compileCommands(doc,[{op:'edit_text',slideId:slide.id,elementId:base.id,value:{text:'Город'}}]);
 assert.deepEqual(changes[0].after.canvas[0],slide.canvas[0]);
 assert.doesNotThrow(()=>assertEditDesign(doc,changes));
});

test('two text edits can be reviewed independently and do not overwrite later manual edits',()=>{
 const doc=demoDoc(),slide=doc.slides[0];slide.canvas=[base,{...base,id:'second',y:500,text:'Второй объект'}];
 const [{after}]=compileCommands(doc,[{op:'edit_text',slideId:slide.id,elementId:base.id,value:{text:'Первый вариант'}},{op:'edit_text',slideId:slide.id,elementId:'second',value:{text:'Второй вариант'}}]);
 const change={id:'change',slideId:slide.id,before:structuredClone(slide),after,status:'pending'};
 assert.deepEqual(pendingObjects(change),[base.id,'second']);
 const current=mergeObjects(slide,change,[base.id]);recordObjectDecisions(change,[base.id],'accepted');
 assert.equal(current.canvas[0].text,'Первый вариант');assert.equal(current.canvas[1].text,'Второй объект');assert.deepEqual(pendingObjects(change),['second']);
 current.canvas[1].text='Ручная правка';assert.throws(()=>mergeObjects(current,change,['second']),/Конфликт/);
 assert.equal(current.canvas[1].text,'Ручная правка');
});
