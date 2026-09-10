import {useRef,useState} from 'react';
import type {ChatView} from '../lib/agents/contracts';
import {Button} from './ui/button';

type Request=NonNullable<ChatView['inputRequests']>[number];
export function AgentInputRequest({request,onAnswer}:{request:Request;onAnswer:(id:string,answers:Record<string,{answers:string[]}>)=>Promise<void>}){
 const [values,setValues]=useState<Record<string,string>>({});const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const [sent,setSent]=useState(false);const inFlight=useRef(false);
 const complete=request.questions.every(q=>typeof values[q.id]==='string'&&values[q.id].trim().length>0);
 return <form className="agent-input-request" aria-label="Вопрос агента" onSubmit={async e=>{
  e.preventDefault();if(!complete||sent||inFlight.current)return;inFlight.current=true;setBusy(true);setError('');
  try{await onAnswer(request.id,Object.fromEntries(request.questions.map(q=>[q.id,{answers:[values[q.id]]}])));setSent(true);}
  catch{setError('Ответ не подтверждён. Проверьте состояние поручения перед повтором.');}
  finally{inFlight.current=false;setBusy(false);}
 }}>
  <strong>{request.kind==='confirmation'?'Подтверждение действия':'Агент ждёт вашего ответа'}</strong>
  {request.questions.map(q=><fieldset key={q.id} disabled={busy||sent}><legend>{q.question}</legend>
   {q.options?.map((option,i)=><label key={i}><input type="radio" name={request.id+q.id} checked={values[q.id]===option.label} onChange={()=>setValues(v=>({...v,[q.id]:option.label}))}/><span>{request.kind==='confirmation'?({Accept:"Разрешить один раз",Decline:"Отклонить",Cancel:"Отменить запрос"} as Record<string,string>)[option.label]||option.label:option.label}<small>{option.description}</small></span></label>)}
   {(!q.options?.length||q.isOther)&&<label>Ваш ответ<input type="text" maxLength={16000} value={values[q.id]||''} onChange={e=>setValues(v=>({...v,[q.id]:e.target.value}))}/></label>}
  </fieldset>)}
  {error&&<p role="alert">{error}</p>}
  {sent&&<p role="status">Ответ отправлен. Ждём обновления поручения.</p>}
  <Button type="submit" disabled={!complete||busy||sent}>{sent?'Ответ отправлен':busy?'Отправляем…':'Отправить ответ'}</Button>
 </form>;
}
