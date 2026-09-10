import type { Brand, Slide } from "./model";
import type { Primitive, Scene } from "./scene";
import tokens from "../../design-packs/focus-v1/tokens.json";
import { wrap, measure } from "./scene-text";

/** Pinned v1 geometry. Never mutate a released recipe; introduce v2 instead. */
export function focusScene(s: Slide, b: Brand, index: number, total: number): Scene {
  const items: Primitive[] = [];
  let dataRange:Scene["dataRange"];
  let overflow = false;
  const {margin:m, width:W, height:H}=tokens.canvas, inner=W-2*m;
  const font=tokens.typography;
  const rect=(x:number,y:number,w:number,h:number,color:string)=>items.push({kind:"rect",x,y,w,h,color});
  const text=(value:string,x:number,y:number,w:number,h:number,size:number,color=b.ink,bold=false)=>{
    const lines=wrap(value,w,size,bold);
    if(lines.length*size*font.lineHeight>h || value.split(/\s+/).some(v=>measure(v,size,bold)>w))overflow=true;
    lines.forEach((v,i)=>{if(v)items.push({kind:"text",text:v,x,y:y+i*size*font.lineHeight,w,size,color,bold});});
  };
  const blend=(weight:number)=>"#"+[1,3,5].map(i=>Math.round(parseInt(b.paper.slice(i,i+2),16)*(1-weight)+parseInt(b.ink.slice(i,i+2),16)*weight).toString(16).padStart(2,"0")).join("");
  const muted=blend(.74), rule=blend(.18), dark=s.layout==="statement", color=dark?b.paper:b.ink;
  rect(0,0,W,H,dark?b.ink:b.paper);
  text(b.company || b.name,m,46,1000,36,22,color,true);
  text(s.eyebrow,m,114,inner,34,font.label,dark?b.paper:b.primary);
  text(String(index+1).padStart(2,"0")+" / "+String(total).padStart(2,"0"),W-m-112,850,112,30,font.caption,color);
  // Source names live in notes and the source panel; meaningless repeated [1] markers are omitted.
  rect(m,822,inner,1,dark?b.paper:rule);
  const heading=()=>text(s.title,m,194,inner,166,font.title);
  const parts=s.body.split(/\n\s*\n/).filter(v=>v.trim());
  const paragraph=(value:string,x:number,y:number,w:number,h:number)=>{
    const [lead,...rest]=value.split("\n");
    const hh=wrap(lead,w,font.lead,true).length*font.lead*font.lineHeight;
    text(lead,x,y,w,hh+1,font.lead,b.ink,true);
    if(rest.length)text(rest.join("\n"),x,y+hh+22,w,h-hh-22,font.body);
  };
  switch(s.layout){
    case "cover": case "closing":
      rect(m,220,96,5,b.primary);
      text(s.title,m,270,inner,366,font.cover);
      text(s.body,m,671,1130,128,34,muted);
      break;
    case "statement":
      text(s.title,m,238,inner,365,88,color);
      text(s.body,m,671,1180,122,34,color);
      break;
    case "content": {
      text(s.title,m,219,515,485,font.title);
      if(parts.length>3)overflow=true;
      const row=552/Math.max(1,Math.min(3,parts.length));
      parts.slice(0,3).forEach((p,i)=>{
        rect(704,221+i*row,808,1,rule);
        paragraph(p,704,248+i*row,808,row-46);
      });
      break;
    }
    case "split":
      heading();
      if(parts.length!==2)overflow=true;
      parts.slice(0,2).forEach((p,i)=>{
        const x=m+i*(inner+64)/2,w=(inner-64)/2;
        rect(x,426,w,3,i?b.primary:rule);
        paragraph(p,x,467,w,315);
      });
      break;
    case "steps": {
      heading();
      if(parts.length<2 || parts.length>4)overflow=true;
      const col=inner/Math.max(2,Math.min(4,parts.length));
      rect(m,447,inner,1,rule);
      parts.slice(0,4).forEach((p,i)=>{
        const x=m+i*col;
        text(String(i+1).padStart(2,"0"),x,382,col-24,64,48,b.primary);
        paragraph(p,x,493,col-40,295);
      });
      break;
    }
    case "metrics": {
      heading();
      const col=inner/Math.max(1,s.metrics.length);
      s.metrics.forEach((v,i)=>{
        const x=m+i*col;
        text(v.value.toLocaleString("ru-RU"),x,434,col-36,147,s.metrics.length>3?94:118,b.primary);
        text(v.unit,x,592,col-36,48,30);
        text(v.label,x,668,col-36,86,30,muted);
      });
      text(s.body,m,775,inner,40,font.caption,muted);
      break;
    }
    case "table": {
      heading();
      if(!s.table){overflow=true;break;}
      const dataStart=items.length;
      const col=inner/s.table.columns.length,row=Math.min(91,337/s.table.rows.length);
      s.table.columns.forEach((v,j)=>text(v,m+j*col,402,col-36,65,26,b.primary,true));
      rect(m,464,inner,2,b.ink);
      s.table.rows.forEach((cells,i)=>{
        const y=474+i*row;
        cells.forEach((v,j)=>text(v,m+j*col,y+12,col-36,row-17,26,b.ink,j===0));
        rect(m,y+row-1,inner,1,rule);
      });
      // Explanation belongs in notes if table uses the full frame.
      dataRange={start:dataStart,end:items.length};

      break;
    }
    case "chart": {
      heading();
      const dataStart=items.length;
      const lo=Math.min(0,...s.chart.map(v=>v.value)),hi=Math.max(0,...s.chart.map(v=>v.value)),span=hi-lo||1;
      const x=440,w=822,zero=x-lo/span*w,row=380/Math.max(1,s.chart.length);
      rect(zero,398,1,379,rule);
      s.chart.forEach((v,i)=>{
        const y=402+i*row,end=x+(v.value-lo)/span*w;
        text(v.label,m,y,322,row-4,27);
        if(v.value)rect(Math.min(zero,end),y+4,Math.abs(end-zero),row-14,b.primary);
        text(`${v.value.toLocaleString("ru-RU")} ${s.chartUnit}`,1294,y,218,row-4,27);
      });
      dataRange={start:dataStart,end:items.length};
      text(s.body,m,784,inner,33,font.caption,muted);
      break;
    }
    case "image":
      text(s.title,m,207,inner,158,font.title);
      text(s.body,m,446,402,309,font.body,muted);
      if(s.assetId)items.push({kind:"image",assetId:s.assetId,x:552,y:378,w:960,h:422});
      else overflow=true;
      break;
  }
  return {items,overflow,dataRange};
}
