/** Reproduce the synthetic fact-row layout corpus. Never certifies a brand or overwrites goldens. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {pdfBytes} from '../lib/export';
import {pdfFontFiles} from '../lib/domain/scene-typography';
import {blankSlide,validateDoc} from '../lib/domain/model';
import {focusV3Scene} from '../lib/domain/focus-v3';
import corpus from '../design-packs/focus-v3/fact-rows-corpus.json';
import example from '../lib/examples/lanka-sales-focus-v3.json';
await mkdir('out/fact-rows-matrix',{recursive:true});
const slides=corpus.map(c=>({...blankSlide(),id:c.id,title:c.title,body:c.parts.map(p=>p.join('\n')).join('\n\n'),layout:c.layout||'content',intent:{role:c.role||'evidence',takeaway:'Синтетический тест композиции',transition:'',openQuestions:[]}}));
const doc=validateDoc({...example.doc,id:'fact-rows-corpus',title:'Synthetic layout corpus',slides});
const rows=doc.slides.map((s,i)=>{const r=focusV3Scene(s,doc.brand,i,slides.length);return {id:s.id,expected:corpus[i].expected,actual:r.overflow?'reject':r.meta.variant,overflow:r.overflow,...r.meta};});
await writeFile('out/fact-rows-matrix/results.json',JSON.stringify(rows,null,2));
const fonts=await Promise.all(pdfFontFiles(doc.design).map(f=>readFile('public/fonts/'+f)));
// Rejected slides are deliberately excluded from the deliverable preview.
await writeFile('out/fact-rows-matrix/accepted.pdf',await pdfBytes({...doc,slides:doc.slides.filter((_,i)=>!rows[i].overflow)},fonts[0],fonts[1],undefined,fonts[2]));
console.log(JSON.stringify(rows.map(({id,expected,actual})=>({id,expected,actual})),null,2));
