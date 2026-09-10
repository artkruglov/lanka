import { z } from "zod";
import type { DeckDoc } from "./model";
import { briefOriginsSchema } from "./briefing";

export const narrativeRoles = [
  "context",
  "problem",
  "evidence",
  "options",
  "recommendation",
  "decision",
  "next_step",
] as const;
export const roleNames: Record<(typeof narrativeRoles)[number], string> = {
  context: "Контекст",
  problem: "Проблема",
  evidence: "Доказательство",
  options: "Варианты",
  recommendation: "Рекомендация",
  decision: "Решение",
  next_step: "Следующий шаг",
};
export const briefSchema = z
  .object({
    audience: z.string().max(400),
    decision: z.string().max(800),
    keyMessage: z.string().max(800),
    origins: briefOriginsSchema.optional(),
  })
  .strict();
export const intentSchema = z
  .object({
    role: z.enum(narrativeRoles),
    takeaway: z.string().max(800),
    transition: z.string().max(800),
    openQuestions: z.array(z.string().min(1).max(400)).max(8),
  })
  .strict();
export type Brief = z.infer<typeof briefSchema>;
export type NarrativeIssue = {
  code: string;
  slideId?: string;
  message: string;
};

/** Completeness signals only. Never certify logic, evidence or factual accuracy. */
export function inspectNarrative(doc: DeckDoc): NarrativeIssue[] {
  const issues: NarrativeIssue[] = [];
  if (
    !doc.brief?.audience.trim() ||
    !doc.brief.decision.trim() ||
    !doc.brief.keyMessage.trim()
  )
    issues.push({
      code: "brief-incomplete",
      message: "Уточните аудиторию, ожидаемое решение и главную мысль.",
    });
  const claims = new Set<string>();
  doc.slides.forEach((s, i) => {
    if (!s.intent?.takeaway.trim()) {
      issues.push({
        code: "intent-missing",
        slideId: s.id,
        message: "Не сформулирован вывод, который должен сделать читатель.",
      });
      return;
    }
    const claim = s.intent.takeaway
      .trim()
      .toLocaleLowerCase("ru-RU")
      .replace(/\s+/g, " ");
    if (claims.has(claim))
      issues.push({
        code: "repeated-takeaway",
        slideId: s.id,
        message:
          "Этот вывод повторяется. Проверьте, нужна ли отдельная страница.",
      });
    claims.add(claim);
    if (i < doc.slides.length - 1 && !s.intent.transition.trim())
      issues.push({
        code: "transition-missing",
        slideId: s.id,
        message: "Не объяснён переход к следующему слайду.",
      });
    if (
      s.intent.role === "evidence" &&
      !s.sourceIds.length &&
      !s.metrics.some((m) => m.sourceId)
    )
      issues.push({
        code: "evidence-unlinked",
        slideId: s.id,
        message: "Слайд заявлен как доказательство, но источник не прикреплён.",
      });
    if (s.intent.openQuestions.length)
      issues.push({
        code: "open-questions",
        slideId: s.id,
        message: `Открытых вопросов: ${s.intent.openQuestions.length}.`,
      });
  });
  if (
    !doc.slides.some(
      (s) => s.intent?.role === "decision" || s.intent?.role === "next_step",
    )
  )
    issues.push({
      code: "outcome-missing",
      message: "Не обозначен слайд с решением или следующим действием.",
    });
  return issues;
}
