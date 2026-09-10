import type { Brand, Slide } from "./model";
import type { Primitive, Scene } from "./scene";
import tokens from "../../design-packs/focus-v2/tokens.json";
import { measure, wrap } from "./scene-text";

/** Focus v2 is independent of v1. All outputs use this same deterministic scene. */
export function focusV2Scene(s: Slide, b: Brand, index: number, total: number): Scene {
  const items: Primitive[] = [];
  let dataRange:Scene["dataRange"];
  let overflow = false;
  const { width: W, height: H, margin: m } = tokens.canvas, inner = W - 2*m;
  const f = tokens.typography;
  const rect = (x:number,y:number,w:number,h:number,color:string) => items.push({kind:"rect",x,y,w,h,color});
  const text = (value:string,x:number,y:number,w:number,h:number,size:number,color=b.ink,bold=false,editField?:string) => {
    const lines = wrap(value,w,size,bold);
    if (lines.length*size*f.lineHeight > h || value.split(/\s+/).some(v=>measure(v,size,bold)>w)) overflow=true;
    lines.forEach((v,i)=>{if(v)items.push({kind:"text",text:v,x,y:y+i*size*f.lineHeight,w,size,color,bold,editField});});
  };
  const mix = (weight:number) => "#"+[1,3,5].map(i=>Math.round(parseInt(b.paper.slice(i,i+2),16)*(1-weight)+parseInt(b.ink.slice(i,i+2),16)*weight).toString(16).padStart(2,"0")).join("");
  const muted=mix(.75), rule=mix(.17), cover=s.layout==="cover", statement=s.layout==="statement", closing=s.layout==="closing";
  rect(0,0,W,H,statement?b.ink:b.paper);
  if(cover)rect(0,0,W,600,b.primary);
  if(closing)rect(0,624,W,H-624,b.primary);
  const headerColor=cover||statement?b.paper:b.ink;
  text(b.company||b.name,m,46,256,34,22,headerColor,true);
  text(s.eyebrow,360,48,W-m-360,28,f.label,headerColor,false,"eyebrow");
  rect(m,106,inner,1,cover||statement?b.paper:rule);
  text(String(index+1).padStart(2,"0")+" / "+String(total).padStart(2,"0"),W-m-112,tokens.canvas.footerY,112,28,f.caption,statement||closing?b.paper:muted);
  const heading=()=>text(s.title,m,170,inner,156,f.title,b.ink,true,"title");
  const parts=s.body.split(/\n\s*\n/).filter(v=>v.trim());
  const paragraph=(value:string,x:number,y:number,w:number,h:number) => {
    const [lead,...body]=value.split("\n"), hh=wrap(lead,w,f.lead,true).length*f.lead*f.lineHeight;
    text(lead,x,y,w,hh+1,f.lead,b.ink,true,"body");
    if(body.length)text(body.join("\n"),x,y+hh+16,w,h-hh-16,f.body,muted,false,"body");
  };
  switch(s.layout){
    case "cover":
      text(s.title,m,192,inner,358,f.cover,b.paper,true,"title");
      text(s.body,m,664,inner,135,34,b.ink,false,"body");
      break;
    case "statement":
      text(s.title,m,202,inner,365,92,b.paper,true,"title");
      text(s.body,m,671,inner,125,34,b.paper,false,"body");
      break;
    case "closing":
      text(s.title,m,196,inner,330,88,b.primary,true,"title");
      text(s.body,m,671,inner,127,34,b.paper,false,"body");
      break;
    case "content": {
      text(s.title,m,181,510,573,f.title,b.ink,true,"title");
      if(parts.length<1||parts.length>3)overflow=true;
      const row=588/Math.max(1,Math.min(3,parts.length));
      parts.slice(0,3).forEach((p,i)=>{
        const y=184+i*row;
        rect(712,y,800,1,rule);
        paragraph(p,712,y+28,800,row-46);
      });
      break;
    }
    case "split": {
      heading();
      if(parts.length!==2)overflow=true;
      const col=(inner-tokens.spacing.columnGap)/2;
      rect(W/2,385,1,371,rule);
      parts.slice(0,2).forEach((p,i)=>{
        const x=m+i*(col+tokens.spacing.columnGap),[label,...body]=p.split("\n");
        text(label,x,393,col,64,24,b.primary,true,"body");
        text(body.join("\n"),x,479,col,296,f.comparison,b.ink,false,"body");
      });
      break;
    }
    case "steps": {
      text(s.title,m,181,516,567,f.title,b.ink,true,"title");
      if(parts.length<2||parts.length>4)overflow=true;
      const row=608/Math.max(2,Math.min(4,parts.length));
      parts.slice(0,4).forEach((p,i)=>{
        const y=184+i*row;
        text(String(i+1).padStart(2,"0"),712,y+14,86,61,44,b.primary);
        paragraph(p,822,y+17,690,row-24);
        if(i<parts.length-1)rect(712,y+row-1,800,1,rule);
      });
      break;
    }
    case "metrics": {
      heading();
      const col=inner/Math.max(1,s.metrics.length);
      s.metrics.forEach((v,i)=>{
        const x=m+i*col;
        text(v.value.toLocaleString("ru-RU"),x,398,col-36,178,s.metrics.length>3?112:f.metric,b.primary,false,`metric:${v.id}:value`);
        text(v.unit,x,585,col-36,81,30,b.ink,true,`metric:${v.id}:unit`);
        text(v.label,x,691,col-36,77,28,muted,false,`metric:${v.id}:label`);
      });
      text(s.body,m,798,inner,28,f.caption,muted,false,"body");
      break;
    }
    case "table": {
      heading();
      if(!s.table){overflow=true;break;}
      const dataStart=items.length;
      const col=inner/s.table.columns.length,row=Math.min(91,384/s.table.rows.length);
      rect(m,365,inner,88,b.primary);
      s.table.columns.forEach((v,j)=>text(v,m+20+j*col,382,col-40,66,26,b.paper,true,`table:column:${j}`));
      s.table.rows.forEach((cells,i)=>{
        const y=453+i*row;
        cells.forEach((v,j)=>text(v,m+20+j*col,y+15,col-40,row-20,26,b.ink,j===0,`table:${i}:${j}`));
        rect(m,y+row,inner,1,rule);
      });
      dataRange={start:dataStart,end:items.length};

      break;
    }
    case "chart": {
      heading();
      const dataStart=items.length;
      const lo=Math.min(0,...s.chart.map(v=>v.value)),hi=Math.max(0,...s.chart.map(v=>v.value)),span=hi-lo||1;
      const x=440,w=822,zero=x-lo/span*w,row=380/Math.max(1,s.chart.length);
      rect(zero,389,1,387,rule);
      s.chart.forEach((v,i)=>{
        const y=394+i*row,end=x+(v.value-lo)/span*w;
        text(v.label,m,y,322,row-4,27,b.ink,false,`chart:${i}:label`);
        if(v.value)rect(Math.min(zero,end),y+4,Math.abs(end-zero),row-14,b.primary);
        text(`${v.value.toLocaleString("ru-RU")} ${s.chartUnit}`,1294,y,218,row-4,27,b.ink,false,`chart:${i}:value`);
      });
      dataRange={start:dataStart,end:items.length};
      text(s.body,m,798,inner,28,f.caption,muted,false,"body");
      break;
    }
    case "image":
      heading();
      text(s.body,m,434,402,340,f.body,muted,false,"body");
      if(s.assetId)items.push({kind:"image",assetId:s.assetId,x:552,y:365,w:960,h:435});
      else overflow=true;
      break;
  }
  return {items,overflow,dataRange};
}
