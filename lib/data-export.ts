import type PptxGenJS from 'pptxgenjs';
import {canvasToInches} from './domain/scene';
import {dataObjectSlide,type DataObject} from './domain/data-object';
/** Native Office objects retain their data; PDF remains the exact recipe rendering. */
export function addNativeData(page:PptxGenJS.Slide,pptx:PptxGenJS,e:DataObject){
 const b=e.style.brand,plex=e.style.design==='focus-v3',font=plex?'IBM Plex Sans':'DejaVu Sans';
 const box={x:canvasToInches(e.x),y:canvasToInches(e.y),w:canvasToInches(e.w),h:canvasToInches(e.h)};
 if(e.kind==='chart'){
  const values=e.data.rows.map(r=>r.value),lo=Math.min(0,...values),hi=Math.max(0,...values),pad=(hi-lo||1)*.18;
  // PptxGenJS forwards maxMin into OOXML; its 4.0.1 declaration lists only minMax.
  page.addChart(pptx.ChartType.bar,[{name:e.data.unit||'Значение',labels:e.data.rows.map(r=>r.label),values}],{
   ...box,objectName:e.id,barDir:e.style.design==='classic-v1'?'col':'bar',barGrouping:'clustered',barGapWidthPct:65,
   showLegend:false,showTitle:false,showValue:true,
   catAxisLabelFontFace:font,catAxisLabelFontSize:14,catAxisLabelColor:b.ink.slice(1),catAxisLineShow:false,
   catAxisLabelPos:'low',catAxisOrientation:(e.style.design==='classic-v1'?'minMax':'maxMin') as 'minMax',catAxisMajorTickMark:'none',catAxisMinorTickMark:'none',
   valAxisLabelPos:'none',valAxisLineShow:false,valGridLine:{style:'none'},catGridLine:{style:'none'},
   valAxisMinVal:lo<0?lo-pad:0,valAxisMaxVal:hi>0?hi+pad:lo<0?0:1,
   dataLabelPosition:'outEnd',dataLabelFontFace:font,dataLabelFontSize:13,dataLabelColor:b.ink.slice(1),
   dataLabelFormatCode:'0.########',showValAxisTitle:!!e.data.unit,valAxisTitle:e.data.unit,valAxisTitleFontFace:font,valAxisTitleFontSize:11,valAxisTitleColor:b.ink.slice(1),
   chartColors:[b.primary.slice(1)],invertedColors:[b.ink.slice(1)],
   chartArea:{fill:{color:b.paper.slice(1),transparency:100},roundedCorners:false},plotArea:{fill:{color:b.paper.slice(1),transparency:100}},
  });return;
 }
 const table=dataObjectSlide(e).table!,rows:PptxGenJS.TableRow[]=[table.columns.map(text=>({text,options:{bold:true,color:(plex?b.ink:b.paper).slice(1),fill:{color:(plex?b.paper:b.primary).slice(1)}}})),...table.rows.map(row=>row.map((text,j)=>({text,options:{bold:e.data.columns[j].role==='key',align:e.data.columns[j].role==='number'?'right' as const:'left' as const}})))];
 page.addTable(rows,{...box,objectName:e.id,autoPage:false,fontFace:font,fontSize:14,color:b.ink.slice(1),fill:{color:b.paper.slice(1)},
  border:{type:'solid',color:'D7D9E0',pt:.5},margin:4,rowH:box.h/rows.length,colW:box.w/table.columns.length,valign:'middle',
 });
}
