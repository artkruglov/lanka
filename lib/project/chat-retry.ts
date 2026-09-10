import type {ChatView} from '../agents/contracts';

/** Only a terminal, unanswered edit/discussion may be restored; never enqueue a retry. */
export function recoverableChatRequest(view:ChatView|null){
  if(!view||view.active||view.queued)return null;
  const last=view.messages.at(-1);
  if(!last||last.role!=='assistant'||!['failed','interrupted'].includes(last.status)||last.mode==='create'||last.proposalId)return null;
  const request=view.messages.at(-2);
  if(!request||request.role!=='user'||request.mode!==last.mode)return null;
  return {request,status:last.status};
}
