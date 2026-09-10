import type {Proposal} from './model';
/** Content-free metadata; callers still enforce proposal visibility and document access. */
export function proposalSummary(proposal:Proposal){
 if(proposal.briefChanges){const changes=proposal.briefChanges;return {kind:'brief' as const,slideCount:0,fieldCount:changes.length,decision:proposal.status==='pending'?'pending':changes.every(c=>c.status==='accepted')?'accepted':changes.every(c=>c.status==='rejected')?'rejected':'mixed'};}
 const decisions=proposal.changes.flatMap(c=>[...(c.status==='pending'?['pending']:[]),...(c.objectDecisions?.map(d=>d.status)??[c.status])]);
 const decision=proposal.status==='pending'?'pending':decisions.every(d=>d==='accepted')?'accepted':decisions.every(d=>d==='rejected')?'rejected':'mixed';
 return {kind:proposal.draftCandidate?'draft' as const:'edits' as const,slideCount:proposal.draftCandidate?.after.slides.length??proposal.changes.length,decision};
}
