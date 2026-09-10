export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";
export type AgentRun = {
  id: string;
  deckId: string;
  baseRevision: number;
  status: RunStatus;
  instruction: string;
  actorEmail: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  deadlineAt: number;
  proposalId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  totalTokens: number | null;
  canCancel: boolean;
  canExecute: boolean;
};
export type AgentBudget = {
  dailyLimit: number;
  used: number;
  remaining: number;
  maxInputCharacters: number;
  maxOutputTokens: number;
};
export const runStatusLabels: Record<RunStatus, string> = {
  queued: "Готова к запуску",
  running: "В работе",
  succeeded: "Предложение готово",
  failed: "Не выполнена",
  cancelled: "Отменена",
  expired: "Время истекло",
};
export const activeRun = (status: RunStatus) =>
  status === "queued" || status === "running";
