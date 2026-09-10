"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Sparkles,
  Play,
  Square,
  RefreshCw,
  Loader2,
  CheckCircle2,
  Clock3,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { type Deck } from "@/lib/domain/model";
import {
  type AgentRun,
  type AgentBudget,
  activeRun,
  runStatusLabels,
} from "@/lib/domain/agent-run";
import { clientRequest } from "@/lib/client-request";
type RunList = { runs: AgentRun[]; budget: AgentBudget; configured: boolean };
export function AgentRunPanel({
  deck,
  slideId,
  dirty,
  configured,
  busy,
  onProposalReady,
  onReview,
}: {
  deck: Deck;
  slideId: string;
  dirty: boolean;
  configured: boolean;
  busy: boolean;
  onProposalReady: (deckId: string) => Promise<void>;
  onReview: () => void;
}) {
  const [instruction, setInstruction] = useState(""),
    [scope, setScope] = useState("slide"),
    [data, setData] = useState<RunList | null>(null),
    [error, setError] = useState(""),
    [starting, setStarting] = useState(false),
    [pending, setPending] = useState<string[]>([]);
  const mounted = useRef(true),
    seen = useRef(new Set<string>()),
    latest = useRef({ deck, onProposalReady });
  latest.current = { deck, onProposalReady };
  const refresh = useCallback(async () => {
    const value = await clientRequest<RunList>(
      `/api/agent?deckId=${encodeURIComponent(deck.id)}`,
    );
    if (!mounted.current) return value;
    setData(value);
    setError("");
    const fresh = value.runs.filter(
      (r) =>
        r.status === "succeeded" &&
        r.proposalId &&
        !seen.current.has(r.id) &&
        !latest.current.deck.state.proposals.some((p) => p.id === r.proposalId),
    );
    if (fresh.length) await latest.current.onProposalReady(deck.id);
    value.runs
      .filter((r) => r.status === "succeeded")
      .forEach((r) => seen.current.add(r.id));
    return value;
  }, [deck.id]);
  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    async function poll() {
      try {
        const value = await refresh();
        if (!stopped && value.runs.some((r) => activeRun(r.status)))
          timer = setTimeout(poll, 2500);
      } catch (e) {
        if (!stopped) {
          setError((e as Error).message);
          timer = setTimeout(poll, 8000);
        }
      }
    }
    void poll();
    return () => {
      stopped = true;
      mounted.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, data?.runs.some((r) => activeRun(r.status))]);
  const canEdit = deck.role === "owner" || deck.role === "editor";
  const active = data?.runs.find((r) => activeRun(r.status));
  const available = data?.configured ?? configured;
  async function execute(id: string) {
    setPending((a) => [...a, id]);
    setError("");
    try {
      await clientRequest("/api/agent", { action: "execute", runId: id });
      if (mounted.current) await refresh();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setPending((a) => a.filter((v) => v !== id));
    }
  }
  async function start() {
    if (starting) return;
    setStarting(true);
    setError("");
    try {
      const response = await clientRequest<{ run: AgentRun }>("/api/agent", {
        action: "start",
        deckId: deck.id,
        expectedRevision: deck.state.revision,
        instruction,
        slideIds:
          scope === "deck" ? deck.state.doc.slides.map((s) => s.id) : [slideId],
      });
      if (!mounted.current) return;
      setInstruction("");
      await refresh();
      if (response.run.status === "queued") void execute(response.run.id);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setStarting(false);
    }
  }
  async function cancel(run: AgentRun) {
    try {
      const response = await clientRequest<{ run: AgentRun }>("/api/agent", {
        action: "cancel",
        runId: run.id,
      });
      toast.success(
        response.run.status === "cancelled"
          ? "Задача отменена. Поздний ответ не будет сохранён."
          : `Задача уже завершена: ${runStatusLabels[response.run.status]}`,
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="panel-section">
      <div className="row mb-3">
        <Sparkles size={19} className="text-primary" />
        <h3 className="mb-0">Помощник презентации</h3>
      </div>
      <p className="hint" role="status">{available ? "Помощник настроен. Результат появится в разделе «Изменения агента»." : "Помощник не подключён. Чат с вашей сессией Codex здесь пока недоступен."}</p>
      <label className="field">
        <span>Что нужно изменить?</span>
        <Textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          maxLength={4000}
          disabled={!canEdit || starting || !available}
          placeholder="Сделать формулировки короче. Сохранить числа и смысл."
        />
      </label>
      <label className="field">
        <span>Область работы</span>
        <Select
          value={scope}
          onValueChange={setScope}
          disabled={!canEdit || starting || !available}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="slide">Текущий слайд</SelectItem>
            <SelectItem
              value="deck"
              disabled={deck.state.doc.slides.length > 8}
            >
              Вся презентация · до 8 слайдов
            </SelectItem>
          </SelectContent>
        </Select>
      </label>
      <Button
        className="w-full"
        disabled={
          !canEdit ||
          !available ||
          dirty ||
          busy ||
          starting ||
          Boolean(active) ||
          instruction.trim().length < 3 ||
          (scope === "deck" && deck.state.doc.slides.length > 8) ||
          data?.budget.remaining === 0
        }
        onClick={() => void start()}
      >
        {starting ? (
          <Loader2 className="animate-spin" size={17} />
        ) : (
          <Sparkles size={17} />
        )}
        Подготовить предложение
      </Button>
      {dirty && (
        <p className="hint mt-3">Сохраните слайды перед новой задачей.</p>
      )}
      {!available && (
        <p className="hint mt-3">
          Для работы с внешним Codex скачайте пакет документа, передайте его агенту и загрузите полученное предложение кнопкой ниже. Это обмен файлами; автоматической связи с текущим чатом нет.
        </p>
      )}
      {data && (
        <p className="hint mt-3">
          Сегодня использовано {data.budget.used} из {data.budget.dailyLimit}{" "}
          запусков. Отменённые и неудачные попытки тоже учитываются.
        </p>
      )}
      {error && (
        <div className="error-banner mt-3" role="alert">
          {error}
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            onClick={() => void refresh().catch((e) => setError(e.message))}
          >
            <RefreshCw size={14} />
            Обновить задачи
          </Button>
        </div>
      )}
      {data === null && !error ? (
        <Skeleton className="h-16 mt-4" />
      ) : (
        data &&
        data.runs.length > 0 && (
          <div className="mt-5">
            <h3>История задач</h3>
            <div className="stack">
              {data.runs.slice(0, 5).map((run) => (
                <div key={run.id} className="rounded-lg border p-3">
                  <div className="row text-sm font-semibold mb-2">
                    {run.status === "running" ? (
                      <Loader2
                        className="animate-spin text-primary shrink-0"
                        size={16}
                      />
                    ) : run.status === "succeeded" ? (
                      <CheckCircle2
                        className="text-emerald-700 shrink-0"
                        size={16}
                      />
                    ) : (
                      <Clock3 size={16} className="muted shrink-0" />
                    )}
                    {runStatusLabels[run.status]}
                  </div>
                  <p className="text-sm whitespace-pre-wrap break-words">
                    {run.instruction}
                  </p>
                  <p className="hint">
                    Версия {run.baseRevision} ·{" "}
                    {new Date(run.createdAt).toLocaleString("ru-RU", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    <br />
                    {run.actorEmail}
                    {run.totalTokens !== null && (
                      <> · {run.totalTokens.toLocaleString("ru-RU")} токенов</>
                    )}
                  </p>
                  {run.errorMessage && (
                    <p className="text-sm text-red-700">{run.errorMessage}</p>
                  )}
                  {run.status === "cancelled" && (
                    <p className="hint">
                      Сохранение ответа запрещено. Обработка у провайдера могла
                      продолжиться.
                    </p>
                  )}
                  <div className="row">
                    {run.status === "succeeded" && run.proposalId && <Button size="sm" variant="outline" onClick={onReview}>Посмотреть изменения</Button>}
                    {run.canExecute && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending.includes(run.id)}
                        onClick={() => void execute(run.id)}
                      >
                        <Play size={14} />
                        Запустить
                      </Button>
                    )}
                    {run.canCancel && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void cancel(run)}
                      >
                        <Square size={13} />
                        Отменить
                      </Button>
                    )}
                    {!activeRun(run.status) &&
                      run.status !== "succeeded" &&
                      canEdit && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setInstruction(run.instruction)}
                        >
                          Вернуть текст задачи
                        </Button>
                      )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      )}
    </div>
  );
}
