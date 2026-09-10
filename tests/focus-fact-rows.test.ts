import test from 'node:test';
import assert from 'node:assert/strict';
import {blankSlide,demoDoc,validateDoc} from '../lib/domain/model';
import {focusV3Scene} from '../lib/domain/focus-v3';
test('evidence rows make short facts readable without inventing content or overflowing',()=>{
 const brand=demoDoc().brand;
 for(const body of ['42 заявки\n30 консультаций и 12 внедрений.\n\nПервый ответ\nМедианное время — 2 часа.\n\nБез сравнения\nДанных июля нет.','Период\nАвгуст 2026.\n\nИсточник\nОтчёт отдела.','Один\nПервый факт.\n\nДва\nВторой факт.\n\nТри\nТретий факт.\n\nЧетыре\nЧетвёртый факт.']){
 const slide={...blankSlide(),layout:'content' as const,title:'Показатели отдела',body,intent:{role:'evidence' as const,takeaway:'Факты отчёта',transition:'',openQuestions:[]}};
 const result=focusV3Scene(slide,brand,0,1),ordinary=focusV3Scene({...slide,intent:undefined},brand,0,1);
 assert.equal(result.meta.variant,'fact-rows');assert.equal(result.overflow,false);assert.ok(result.meta.contentHeight>=224);assert.ok(result.meta.gap<ordinary.meta.gap);
 const text=result.items.filter(p=>p.kind==='text'&&p.editField==='body');assert.ok(text.every(p=>p.kind==='text'&&p.size>=28));assert.equal(slide.body,body);
 assert.equal(ordinary.meta.variant,'cols');assert.equal(focusV3Scene({...slide,layout:'steps'},brand,0,1).meta.variant,'cols');
 }
});
test('evidence row fallback does not drop long text',()=>{
 const slide={...blankSlide(),layout:'content' as const,title:'Проверяем длинные пояснения',body:Array.from({length:4},(_,i)=>`Факт ${i+1}\n${'Длинное пояснение '.repeat(30)}`).join('\n\n'),intent:{role:'evidence' as const,takeaway:'Факты',transition:'',openQuestions:[]}};
 const result=focusV3Scene(slide,demoDoc().brand,0,1);assert.match(result.meta.variant,/^cols(?:-wide)?$/);assert.equal(result.overflow,true);
});


import corpus from '../design-packs/focus-v3/fact-rows-corpus.json';
test('mixed corpus preserves body text and bounds, and rejects declared unsupported cases',()=>{
 const base=demoDoc();
 for(const c of corpus){
  const body=c.parts.map(p=>p.join('\n')).join('\n\n');
  const doc=validateDoc({...base,design:'focus-v3',slides:[{...blankSlide(),id:c.id,title:c.title,body,layout:c.layout||'content',intent:{role:c.role||'evidence',takeaway:'Тест',transition:'',openQuestions:[]}}]});
  const r=focusV3Scene(doc.slides[0],doc.brand,0,1);
  assert.equal(r.overflow?'reject':r.meta.variant,c.expected,c.id);
  if(r.overflow)continue;
  const texts=r.items.filter(p=>p.kind==='text'&&p.editField==='body');
  const compact=(s:string)=>s.replace(/\s/g,'');
  assert.equal(compact(texts.map(p=>p.kind==='text'?p.text:'').join('')),compact(body),c.id+': body preserved');
  for(const p of r.items){assert.ok(p.x>=0&&p.y>=0&&p.x+p.w<=1600.5,c.id+': horizontal bounds');assert.ok(p.y+(p.kind==='text'?p.size*(p.lineHeight||1.32):p.h)<=900.5,c.id+': vertical bounds');}
 }
});
