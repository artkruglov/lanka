import {createHash} from 'node:crypto';
import {z} from 'zod';
import {slideSchema,metricSchema,blankSlide,type Slide} from '../domain/model';
/** Concise semantic inputs: the renderer owns geometry and the server supplies stable IDs. */
export const creationSlideSchema=slideSchema.omit({id:true,canvas:true}).partial().extend({
 layout:slideSchema.shape.layout,title:z.string().trim().min(1).max(180),
 metrics:z.array(metricSchema.omit({id:true})).max(4).optional(),
}).strict();
export const creationSlidesSchema=z.array(creationSlideSchema).min(1).max(40);
// RFC 4122 UUID v5: previews and retries share IDs without accepting arbitrary server paths or state.
function stableId(namespace:string,name:string){
 const bytes=createHash('sha1').update(Buffer.from(z.string().uuid().parse(namespace).replaceAll('-',''),'hex')).update(name).digest().subarray(0,16);
 bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
 const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function structuredSlides(requestId:string,input:unknown):Slide[]{
 return creationSlidesSchema.parse(input).map((s,index)=>({
  ...blankSlide(s.layout),...s,id:stableId(requestId,`slide:${index}`),
  metrics:(s.metrics??[]).map((m,i)=>({...m,id:stableId(requestId,`slide:${index}:metric:${i}`)})),
  // New comparisons must state their semantics. Neutral is the default for new input only;
  // existing documents and explicit correction comparisons keep their meaning.
  ...(s.comparison?{comparison:{...s.comparison,mode:s.comparison.mode??'neutral'}}:{}),
 }));
}
const text=(maxLength:number)=>({type:'string',maxLength}),object=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const pair=object({label:text(40),text:text(200)},['label','text']);
/** Shared MCP documentation for the concise input; runtime validation remains creationSlideSchema. */
export const creationSlideInputSchema=object({
 layout:{type:'string',enum:slideSchema.shape.layout.options},title:{...text(180),minLength:1},eyebrow:text(80),body:text(2400),notes:text(4000),
 metrics:{type:'array',maxItems:4,items:object({label:text(70),value:{type:'number'},unit:text(20),sourceId:text(80)},['label','value','unit'])},
 chart:{type:'array',maxItems:8,items:object({label:text(50),value:{type:'number'}},['label','value'])},chartUnit:text(20),sourceIds:{type:'array',maxItems:12,items:text(80)},assetId:text(80),
 table:object({columns:{type:'array',minItems:2,maxItems:4,items:text(60)},rows:{type:'array',minItems:1,maxItems:6,items:{type:'array',minItems:2,maxItems:4,items:text(160)}},columnRoles:{type:'array',minItems:2,maxItems:4,items:{type:'string',enum:['key','text','meta','number']}},sourceId:text(80)},['columns','rows']),
 comparison:object({mode:{type:'string',enum:['neutral','correction']},prompt:pair,before:pair,after:pair,status:text(80)},['before','after']),
 intent:object({role:{type:'string',enum:['context','problem','evidence','options','recommendation','decision','next_step']},takeaway:text(800),transition:text(800),openQuestions:{type:'array',maxItems:8,items:text(400)}},['role','takeaway','transition','openQuestions']),
},['layout','title']);
