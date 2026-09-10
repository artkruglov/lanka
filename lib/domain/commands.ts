import {createBasicObject,basicPlacementUnavailable} from './basic-object';
import {initialImagePlacement,ImagePlacementError} from './image-placement';
import {alignCanvasElement} from './canvas-align';
import {reorderCanvasLayer} from './canvas-layer';
import { allowedLockedUpdate } from "./canvas-lock";
import { z } from "zod";
import { slideSchema, tableSchema, comparisonSchema, canvasElementSchema, type DeckDoc, type Slide } from "./model";
import { withCanvas, growTextBox } from "./canvas";
import { intentSchema } from "./narrative";
const target = {slideId: z.string().min(1).max(80)};
export const semanticCommandSchema = z.discriminatedUnion("op", [
  z.object({...target,op:z.literal("insert_text"),elementId:z.string().min(1).max(80),value:canvasElementSchema.options[0].shape.text.trim().min(1)}).strict(),
  z.object({...target,op:z.literal("insert_shape"),elementId:z.string().min(1).max(80)}).strict(),
  z.object({...target,op:z.literal("insert_image"),elementId:z.string().min(1).max(80),assetId:z.string().min(1).max(80)}).strict(),
  z.object({...target,op:z.literal("align_element"),elementId:z.string().min(1).max(80),direction:z.enum(["left","center","right","top","middle","bottom"])}).strict(),
  z.object({...target,op:z.literal("reorder_element"),elementId:z.string().min(1).max(80),direction:z.enum(['front','back','forward','backward'])}).strict(),
  z.object({...target,op:z.literal("edit_text"),elementId:z.string().min(1).max(80),value:canvasElementSchema.options[0].pick({text:true,size:true,bold:true}).partial().strict().refine(v=>Object.keys(v).length>0,"Specify text, size or bold")}).strict(),
  z.object({...target,op:z.literal("set_element"),value:canvasElementSchema}).strict(),
  z.object({...target,op:z.literal("add_element"),value:canvasElementSchema}).strict(),
  z.object({...target,op:z.literal("remove_element"),elementId:z.string().min(1).max(80)}).strict(),
  z.object({...target,op:z.literal("set_title"),value:slideSchema.shape.title}).strict(),
  z.object({...target,op:z.literal("set_body"),value:slideSchema.shape.body}).strict(),
  z.object({...target,op:z.literal("set_intent"),value:intentSchema}).strict(),
  z.object({...target,op:z.literal("set_takeaway"),value:z.string().trim().min(1).max(800)}).strict(),
  z.object({...target,op:z.literal("set_layout"),value:slideSchema.shape.layout}).strict(),
  z.object({...target,op:z.literal("set_table"),value:tableSchema}).strict(),
  z.object({...target,op:z.literal("set_comparison"),value:comparisonSchema}).strict(),
  z.object({...target,op:z.literal("set_chart"),value:slideSchema.shape.chart,unit:slideSchema.shape.chartUnit,sourceIds:slideSchema.shape.sourceIds}).strict(),
  z.object({...target,op:z.literal("set_image"),assetId:z.string().min(1).max(80)}).strict(),
]);
export const semanticCommandsSchema = z.array(semanticCommandSchema).min(1).max(80);
export function compileCommands(doc: DeckDoc, input: unknown) {
  const commands = semanticCommandsSchema.parse(input), changes = new Map<string,Slide>();
  for (const c of commands) {
    const source=changes.get(c.slideId) || doc.slides.find(s=>s.id===c.slideId);
    if(!source)throw new Error("Slide is outside project");
    const after=structuredClone(source);
    if(after.canvas && !["insert_text","insert_shape","insert_image","align_element","reorder_element","edit_text","set_element","add_element","remove_element","set_takeaway","set_intent"].includes(c.op))
      throw new Error("This slide uses canvas objects. Read slide.canvas and use set_element/add_element/remove_element; semantic fields no longer control its appearance.");
    switch(c.op) {
      case "insert_text": case "insert_shape": {
        if(!after.canvas)throw new Error("This slide uses a template. Use semantic commands; do not unlock it implicitly.");
        if(after.canvas.some(e=>e.id===c.elementId))throw new Error("Object already exists");
        const element=createBasicObject(after.canvas,doc.brand,doc.design,c.elementId,c.op==='insert_text'?'text':'rect',c.op==='insert_text'?c.value:undefined);
        if(!element)throw new Error(basicPlacementUnavailable);
        Object.assign(after,withCanvas(after,[...after.canvas,element]));break;
      }
      case "insert_image": {
        if(!after.canvas)throw new Error("This slide uses a template. Use set_image or choose an explicit canvas slide; do not unlock it implicitly.");
        if(after.canvas.some(e=>e.id===c.elementId))throw new Error("Object already exists");
        const placement=initialImagePlacement(after.canvas);
        if(!placement)throw new ImagePlacementError();
        Object.assign(after,withCanvas(after,[...after.canvas,{id:c.elementId,kind:'image',assetId:c.assetId,...placement}]));break;
      }
      case "align_element": {
        if(!after.canvas)throw new Error("This slide uses a template. Do not unlock it implicitly.");
        const index=after.canvas.findIndex(e=>e.id===c.elementId),element=after.canvas[index];
        if(!element)throw new Error("Object is outside slide");
        if(element.locked)throw new Error("Object layout is locked");
        after.canvas[index]=alignCanvasElement(element,c.direction);
        Object.assign(after,withCanvas(after,after.canvas));break;
      }
      case "reorder_element": {
        if(!after.canvas)throw new Error("This slide uses a template. Do not unlock it implicitly.");
        const element=after.canvas.find(e=>e.id===c.elementId);
        if(!element)throw new Error("Object is outside slide");
        if(element.locked)throw new Error("Object layout is locked");
        Object.assign(after,withCanvas(after,reorderCanvasLayer(after.canvas,c.elementId,c.direction)));break;
      }
      case "edit_text": {
        if(!after.canvas)throw new Error("This slide uses a template. Use semantic commands; do not unlock it implicitly.");
        const index=after.canvas.findIndex(e=>e.id===c.elementId),element=after.canvas[index];
        if(!element||element.kind!=="text")throw new Error("Text object is outside slide or has another type");
        if(element.locked||element.binding)throw new Error("Text object is locked");
        after.canvas[index]=growTextBox({...element,...c.value});
        Object.assign(after,withCanvas(after,after.canvas));break;
      }
      case "set_element": case "add_element": case "remove_element": {
        if(!after.canvas)throw new Error("This slide uses a template. Use semantic commands; do not unlock it implicitly.");
        const id=c.op==="remove_element"?c.elementId:c.value.id;
        const index=after.canvas.findIndex(e=>e.id===id);
        if(c.op==="add_element") {
          if(index>=0)throw new Error("Object already exists");
          after.canvas.push(c.value);
        } else {
          if(index<0)throw new Error("Object is outside slide");
          if(after.canvas[index].locked && !(c.op==="set_element"&&allowedLockedUpdate(after.canvas[index],c.value,index)))throw new Error("Object layout is locked. For the first full-slide background rectangle, set_element may change only color while preserving id, geometry and locked:true. Other locked objects cannot be changed or removed.");
          if(c.op==="remove_element")after.canvas.splice(index,1);else after.canvas[index]=c.value;
        }
        Object.assign(after,withCanvas(after,after.canvas));break;
      }
      case "set_title": after.title=c.value;break;
      case "set_body": after.body=c.value;break;
      case "set_layout": after.layout=c.value;break;
      case "set_intent": after.intent=c.value;break;
      case "set_takeaway":
        if(!after.intent)throw new Error("Plan slide intent before editing its takeaway");
        after.intent.takeaway=c.value;break;
      case "set_table": after.table=c.value; after.layout="table"; if(c.value.sourceId && !after.sourceIds.includes(c.value.sourceId))after.sourceIds.push(c.value.sourceId);break;
      case "set_comparison": after.comparison=c.value; after.layout="split";break;
      case "set_chart": after.chart=c.value;after.chartUnit=c.unit;after.sourceIds=c.sourceIds;after.layout="chart";break;
      case "set_image": after.assetId=c.assetId;after.layout="image";break;
    }
    changes.set(c.slideId,slideSchema.parse(after));
  }
  return Array.from(changes,([slideId,after])=>({slideId,after}));
}
