import type {AgentUsage} from '../agents/contracts';

export function agentUsageText(usage?:AgentUsage) {
  if(!usage)return null;
  const reset=new Date(usage.resetsAt).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
  return `Лимит Lanka: ${usage.used} из ${usage.limit} запусков использовано${usage.queued?`, ${usage.queued} в очереди`:''}. Доступно: ${usage.remaining}. Обновится ${reset}.`;
}
