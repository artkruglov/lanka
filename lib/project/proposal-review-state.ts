import type {Proposal} from '../domain/model';
import {proposalSummary} from '../domain/proposal-summary';

/** Display the live decision without confusing partial progress with a closed review. */
export function proposalReviewState(proposal?:Proposal) {
  if(!proposal)return {decision:'unavailable' as const,label:'Открыть предложение'};
  const decision=proposalSummary(proposal).decision;
  if(decision!=='pending')return {decision,label:{accepted:'Принято',rejected:'Отклонено',mixed:'Принято частично'}[decision]};
  const decisions=proposal.briefChanges??proposal.changes;
  const accepted=decisions.some(c=>c.status==='accepted')||proposal.changes.some(c=>c.objectDecisions?.some(d=>d.status==='accepted'));
  const reviewed=decisions.some(c=>c.status!=='pending')||proposal.changes.some(c=>c.objectDecisions?.length);
  return {decision,label:accepted?'Часть правок принята · осталось проверить':reviewed?'Часть правок отклонена · осталось проверить':'На проверке · посмотреть до и после'};
}
