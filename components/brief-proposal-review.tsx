import type {DeckDoc,Proposal} from '../lib/domain/model';
import {acceptBriefReview} from '../lib/domain/brief-review';
import {Button} from './ui/button';
const labels={audience:'Для кого',decision:'Какое решение нужно',keyMessage:'Главная мысль'};
export function BriefProposalReview({proposal,current,disabled,onAction}:{proposal:Proposal;current:DeckDoc['brief'];disabled:boolean;onAction:(action:string,payload:Record<string,unknown>,message:string)=>void}){
 const changes=proposal.briefChanges??[],pending=changes.filter(c=>c.status==='pending');
 const inputs=changes.map(({id,status,...change})=>change);
 const conflict=(field:typeof changes[number]['field'])=>{try{acceptBriefReview(current,inputs,[field]);return '';}catch(e){return (e as Error).message;}};
 return <section className="review-proposal" aria-label="Предложение замысла">
  <h3>{proposal.title}</h3><p className="hint">{proposal.author==='local-agent'?'Агент':proposal.author} · Замысел презентации · полей: {changes.length}</p>
  <p>Принятые ответы сохранятся в замысле. Содержание слайдов не изменится.</p>
  {changes.map(change=>{const warning=change.status==='pending'?conflict(change.field):'';return <article className="review-object-card" key={change.id}>
   <h4>{labels[change.field]}</h4><div className="review-text-diff"><p><small>Было{change.before.origin==='assumption'?' · Допущение':''}</small><br/><del>{change.before.value||'Не задано'}</del></p><p><small>Предложено</small><br/><ins>{change.after||'Очистить ответ'}</ins></p></div>
   {warning&&<div role="status" className="narrative-warning"><p>{warning}</p><p><strong>Сейчас сохранено:</strong> {current?.[change.field]||'Не задано'}{current?.origins?.[change.field]==='user'?' · Подтверждено пользователем':current?.origins?.[change.field]==='assumption'?' · Допущение':''}</p></div>}
   {change.status==='pending'?<Button size="sm" disabled={disabled||!!warning} onClick={()=>onAction('accept',{proposalId:proposal.id,changeIds:[change.id]},'Ответ принят')}>Принять: {labels[change.field]}</Button>:<p className="hint">{change.status==='accepted'?'Принято':'Отклонено'}</p>}
  </article>;})}
  {!!pending.length&&<div className="review-actions brief-review-actions row mt-4"><Button disabled={disabled||pending.some(c=>!!conflict(c.field))} onClick={()=>onAction('accept',{proposalId:proposal.id,changeIds:pending.map(c=>c.id)},'Замысел принят')}>Принять оставшиеся ответы</Button><Button variant="outline" disabled={disabled} onClick={()=>onAction('reject',{proposalId:proposal.id},'Оставшиеся ответы отклонены')}>Отклонить оставшиеся ответы</Button></div>}
 </section>;
}
