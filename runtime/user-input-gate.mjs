/** Pending native prompts for one active turn. The host must authenticate the human
 * before calling answer; this transport object is not an authorization boundary. */
export class UserInputGate {
  constructor({threadId,turnId}) {
    if(!threadId||!turnId)throw new Error('Active turn required');
    this.threadId=threadId;this.turnId=turnId;this.pending=new Map();this.closed=false;
  }
  register(message,reply) {
    const p=message?.params;
    if(message?.method==='mcpServer/elicitation/request'){
      const schema=p?.requestedSchema;
      // Confirm-only form used by the native MCP tool approval path. Do not
      // silently drop requested fields, URL flows or unknown schema constraints.
      if(this.closed||!['string','number'].includes(typeof message.id)||this.pending.has(message.id)||
        p?.threadId!==this.threadId||p?.turnId!==this.turnId||p.serverName!=='lanka_document'||p.mode!=='form'||
        typeof p.message!=='string'||!p.message||p.message.length>16000||
        !schema||schema.type!=='object'||!schema.properties||Array.isArray(schema.properties)||
        typeof schema.properties!=='object'||Object.keys(schema.properties).length||
        (schema.required!==undefined&&(!Array.isArray(schema.required)||schema.required.length))||
        Object.keys(schema).some(k=>!['type','properties','required','$schema'].includes(k)))return false;
      const params={threadId:p.threadId,turnId:p.turnId,questions:[{id:'mcp_action',header:'MCP',question:p.message,isOther:false,isSecret:false,options:[
        {label:'Accept',description:'Разрешить этот вызов один раз.'},
        {label:'Decline',description:'Отклонить вызов без выполнения.'},
        {label:'Cancel',description:'Отменить запрос подтверждения.'},
      ]}]};
      this.pending.set(message.id,{params,reply,elicitation:true});return true;
    }
    if(this.closed||message?.method!=='item/tool/requestUserInput'||
      !['string','number'].includes(typeof message.id)||this.pending.has(message.id)||
      p?.threadId!==this.threadId||p?.turnId!==this.turnId||typeof p.itemId!=='string'||!p.itemId||
      !Array.isArray(p.questions)||!p.questions.length||p.questions.length>10)return false;
    const ids=new Set();
    for(const q of p.questions){
      if(!q||typeof q.id!=='string'||!q.id||ids.has(q.id)||typeof q.question!=='string'||
        typeof q.header!=='string'||typeof q.isOther!=='boolean'||typeof q.isSecret!=='boolean'||
        !(q.options===null||Array.isArray(q.options)&&q.options.every(o=>o&&typeof o.label==='string'&&typeof o.description==='string')))return false;
      ids.add(q.id);
    }
    // Snapshot rather than retaining a mutable provider envelope. No default answer,
    // autoResolutionMs timer or persistent/session-wide permission is inferred.
    this.pending.set(message.id,{params:structuredClone(p),reply});return true;
  }
  answer(id,answers) {
    const entry=this.pending.get(id);
    if(this.closed||!entry||!answers||typeof answers!=='object'||Array.isArray(answers))return false;
    const questions=entry.params.questions;
    if(Object.keys(answers).length!==questions.length)return false;
    for(const q of questions){
      const values=Object.hasOwn(answers,q.id)?answers[q.id]?.answers:undefined;
      if(!Array.isArray(values)||values.length!==1||typeof values[0]!=='string'||values[0].length>16000)return false;
      if(q.options?.length&&!q.isOther&&!q.options.some(o=>o.label===values[0]))return false;
    }
    this.pending.delete(id);
    const action=entry.elicitation?answers.mcp_action.answers[0].toLowerCase():undefined;
    entry.reply({id,result:action?{action,content:action==='accept'?{}:null,_meta:null}:{answers:structuredClone(answers)}});return true;
  }
  resolved(id){return this.pending.delete(id);}
  close(){this.closed=true;this.pending.clear();}
}
