import {randomUUID} from 'node:crypto';
import {UserInputGate} from './user-input-gate.mjs';
/** Ephemeral projection: provider identifiers and secret questions never reach chat. */
export class UserInputSession {
  constructor(server,scope){
    this.server=server;this.gate=new UserInputGate(scope);this.requests=new Map();
    server.attachUserInputGate(this.gate);
    this.listener=({id})=>{const entry=this.gate.pending.get(id);if(!entry)return;
      if(entry.params.questions.some(q=>q.isSecret)){this.close();server.emit('userInputUnsupported');return;}
      this.requests.set(randomUUID(),id);
    };
    server.on('userInputPending',this.listener);
  }
  view(){
    if(this.gate.closed)return [];
    return [...this.requests].flatMap(([id,nativeId])=>{
      const entry=this.gate.pending.get(nativeId);if(!entry)return [];
      return [{id,kind:entry.elicitation?'confirmation':'question',questions:entry.params.questions.map(({id,header,question,isOther,options})=>({id,header,question,isOther,options:structuredClone(options)}))}];
    });
  }
  answer(id,answers){
    const nativeId=this.requests.get(id);
    return nativeId!==undefined&&this.gate.answer(nativeId,answers);
  }
  close(){this.gate.close();this.requests.clear();this.server.off('userInputPending',this.listener);}
}
