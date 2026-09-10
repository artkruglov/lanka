import type { Brand, Slide } from "./model";
import type { Primitive, Scene } from "./scene";
import { wrap, measure } from "./scene-text";

/** Corporate recipes share deterministic geometry across browser, PDF and PPTX. */
export function folioScene(s: Slide, b: Brand, index: number, total: number, boardroom = false): Scene {
  const items: Primitive[] = [];
  let dataRange:Scene["dataRange"];
  let overflow = false;
  const r = (x: number, y: number, w: number, h: number, color: string) => items.push({kind:"rect", x,y,w,h,color});
  const t = (value: string, x: number, y: number, w: number, h: number, size: number, color = b.ink, bold = false, min = size) => {
    let font = size, lines = wrap(value,w,font,bold);
    while (lines.length * font * 1.16 > h && font > min) {font--; lines = wrap(value,w,font,bold);}
    if (lines.length * font * 1.16 > h) overflow = true;
    if(value.split(/\s+/).some(word=>measure(word,font,bold)>w))overflow=true;
    for (const [i,line] of lines.entries()) if (line) items.push({kind:"text",text:line,x,y:y+i*font*1.16,w,size:font,color,bold});
  };
  const mix = (a: string, c: string, weight: number) => "#" + [1,3,5].map(i => Math.round(parseInt(a.slice(i,i+2),16)*(1-weight)+parseInt(c.slice(i,i+2),16)*weight).toString(16).padStart(2,"0")).join("");
  const surface = mix(b.paper,b.ink,.045), line = mix(b.paper,b.ink,.16), muted = mix(b.paper,b.ink,.7);
  const hero = !boardroom && (s.layout === "cover" || s.layout === "closing");
  const fg = hero ? b.paper : b.ink, bg = hero ? b.ink : b.paper;
  r(0,0,1600,900,bg);
  r(64,52,18,18,hero ? b.accent : b.primary);
  t(b.company || b.name,98,48,850,34,22,fg,true);
  t(s.eyebrow,64,128,1450,40,19,hero ? b.accent : b.primary,true);
  r(64,834,1472,1,hero ? mix(b.ink,b.paper,.25) : line);
  const footer = s.sourceIds.length ? `Материалы ${s.sourceIds.map((_,i)=>`[${i+1}]`).join(" · ")}` : "";
  t(footer,64,853,1300,25,14,hero ? b.paper : muted);
  t(`${String(index+1).padStart(2,"0")} / ${String(total).padStart(2,"0")}`,1430,853,110,25,14,fg);
  const heading = () => t(s.title,64,200,1435,157,64,b.ink,true,48);
  const paragraphs = s.body.split(/\n\s*\n/).filter(p=>p.trim());
  const block = (value: string,x:number,y:number,w:number,h:number,color=b.ink) => {
    const [lead,...rest] = value.split("\n");
    if (!rest.length) return t(lead,x,y,w,h,32,color,false,26);
    const headHeight=Math.min(94,Math.max(47,wrap(lead,w,40,true).length*47));
    t(lead,x,y,w,headHeight,40,color,true,36);
    t(rest.join("\n"),x,y+headHeight+16,w,h-headHeight-16,28,color,false,27);
  };
  switch(s.layout) {
    case "cover":
    case "closing": {
      // Editorial hierarchy with an offset accent field; no fabricated product screenshot.
      if (hero) {
        r(1120,197,416,597,b.accent);
        t(s.layout === "cover" ? (b.company || b.name).trim().charAt(0).toUpperCase() : "→",1157,251,348,344,270,b.ink,true,220);
        r(1160,635,336,2,b.ink);
        t(b.company || b.name,1160,680,330,94,27,b.ink,true,24);
      } else {
        r(64,213,9,340,b.primary);
        t("РЕШЕНИЕ / ДОКУМЕНТ",1090,730,420,50,20,muted,true);
      }
      t(s.title,boardroom ? 105 : 64,217,boardroom ? 1390 : 997,360,boardroom ? 86 : 84,fg,true,64);
      t(s.body,boardroom ? 105 : 64,655,boardroom ? 875 : 965,145,30,fg,false,26);
      break;
    }
    case "statement":
      r(64,205,1472,421,boardroom ? surface : b.primary);
      t(s.title,105,255,1370,300,82,boardroom ? b.ink : "#FFFFFF",true,64);
      t(s.body,405,674,1090,121,29,b.ink,false,25);
      t("ГЛАВНАЯ МЫСЛЬ",64,682,285,60,18,b.primary,true);
      break;
    case "content": {
      t(s.title,64,211,560,522,65,b.ink,true,49);
      const count = Math.max(1,Math.min(3,paragraphs.length));
      if (paragraphs.length > 3) overflow = true;
      const row = 570/count;
      paragraphs.slice(0,3).forEach((p,i) => {
        r(699,218+i*row,837,row-18,boardroom ? b.paper : surface);
        r(699,218+i*row,3,row-18,i === 0 ? b.primary : line);
        t(String(i+1).padStart(2,"0"),726,246+i*row,62,38,20,b.primary,true);
        block(p,824,240+i*row,665,row-39);
      });
      break;
    }
    case "split": {
      heading();
      if (paragraphs.length !== 2) overflow = true;
      paragraphs.slice(0,2).forEach((p,i)=> {
        const x=64+i*752;
        r(x,403,720,384,i && !boardroom ? b.ink : surface);
        r(x,403,720,6,i ? b.primary : line);
        const color = i && !boardroom ? b.paper : b.ink;
        t(i ? "02" : "01",x+36,438,100,58,40,i && !boardroom ? b.accent : b.primary,true);
        block(p,x+36,536,648,220,color);
      });
      break;
    }
    case "steps": {
      heading();
      if (paragraphs.length<2 || paragraphs.length>4) overflow = true;
      const n=Math.max(2,Math.min(4,paragraphs.length)),col=1472/n;
      paragraphs.slice(0,4).forEach((p,i)=> {
        const x=64+i*col;
        r(x,408,col-24,377,boardroom ? surface : i === n-1 ? b.ink : surface);
        const color = !boardroom && i === n-1 ? b.paper : b.ink;
        t(String(i+1).padStart(2,"0"),x+25,438,col-66,99,72,!boardroom && i === n-1 ? b.accent : b.primary,true);
        block(p,x+25,567,col-76,199,color);
      });
      break;
    }
    case "metrics": {
      heading();
      const col=1472/Math.max(1,s.metrics.length);
      s.metrics.forEach((m,i)=> {
        const x=64+i*col;
        r(x,411,col-22,326,boardroom ? surface : i===0 ? b.ink : surface);
        const color=!boardroom && i===0 ? b.paper : b.ink;
        t(m.value.toLocaleString("ru-RU"),x+27,441,col-76,138,s.metrics.length>3 ? 81 : 110,!boardroom && i===0 ? b.accent : b.primary,true,65);
        t(m.unit,x+27,585,col-72,38,23,color);
        t(m.label,x+27,646,col-72,80,26,color,false,23);
      });
      t(s.body,64,769,1460,42,18,muted);
      break;
    }
    case "chart": {
      heading();
      const dataStart=items.length;
      const min=Math.min(0,...s.chart.map(p=>p.value)), max=Math.max(0,...s.chart.map(p=>p.value));
      const range=max-min || 1, zero=415+(-min/range)*850, row=373/Math.max(1,s.chart.length);
      r(394,390,898,395,surface);
      s.chart.forEach((p,i)=> {
        const y=401+i*row, end=415+((p.value-min)/range)*850;
        t(p.label,64,y+6,300,row-5,27,b.ink,false,20);
        r(zero,y,1,row-10,line);
        if(p.value)r(Math.min(zero,end),y+4,Math.abs(end-zero),row-18,i===0 ? b.primary : mix(b.primary,b.paper,.4));
        t(`${p.value.toLocaleString("ru-RU")} ${s.chartUnit}`,1330,y+6,203,row-5,26,b.ink,true,20);
      });
      dataRange={start:dataStart,end:items.length};
      t(s.body,64,794,1460,30,17,muted);
      break;
    }
    case "table": {
      heading();
      const table=s.table;
      if(!table){overflow=true;break;}
      const dataStart=items.length;
      const col=1472/table.columns.length, row=Math.min(96,342/table.rows.length);
      r(64,395,1472,66,b.ink);
      table.columns.forEach((v,j)=>t(v,85+j*col,413,col-43,39,23,b.paper,true,20));
      table.rows.forEach((cells,i)=> {
        const y=461+i*row;
        r(64,y,1472,row,i%2===0?surface:b.paper);
        r(64,y+row-1,1472,1,line);
        cells.forEach((v,j)=>t(v,85+j*col,y+17,col-45,row-23,25,b.ink,j===0,20));
      });
      dataRange={start:dataStart,end:items.length};
      t(s.body,64,802,1460,28,16,muted);
      break;
    }
    case "image":
      t(s.title,64,215,495,320,60,b.ink,true,44);
      t(s.body,64,590,495,195,27,b.ink,false,24);
      r(635,200,901,592,surface);
      if (s.assetId) items.push({kind:"image",assetId:s.assetId,x:653,y:218,w:865,h:556});
      else {overflow=true;t("Добавьте изображение",693,434,770,80,38,muted);}
      break;
  }
  return {items,overflow,dataRange};
}
