import { z } from "zod";

export const briefingFields = ["audience", "decision", "keyMessage"] as const;
export const briefingPrompts = {
  audience: {text: "Кто увидит презентацию и что уже знает о теме?", reason: "От этого зависят язык, глубина и первый слайд."},
  decision: {text: "Что человек должен решить или сделать после просмотра?", reason: "Это задаёт аргументацию и следующий шаг."},
  keyMessage: {text: "Какую мысль нужно донести? На какие материалы можно опереться?", reason: "Так агент отделяет доказанные факты от предположений."},
};
const answer = z.object({value: z.string().trim().min(1).max(800), origin: z.enum(["user", "assumption"])}).strict();
/** Records the interview, not proof that the agent actually spoke to a human. */
export const briefingSchema = z.object({audience: answer.extend({value: z.string().trim().min(1).max(400)}), decision: answer, keyMessage: answer}).strict();
export type Briefing = z.infer<typeof briefingSchema>;
export const briefingAssumptions = (b: Briefing) => briefingFields.filter(k => b[k].origin === "assumption").map(k => `${briefingPrompts[k].text} — ${b[k].value}`);

export const briefingInputSchema = briefingSchema.partial();
export const briefOriginsSchema = z.object({
  audience: z.enum(["user", "assumption"]).optional(),
  decision: z.enum(["user", "assumption"]).optional(),
  keyMessage: z.enum(["user", "assumption"]).optional(),
}).strict();
type BriefValues = {
  audience: string;
  decision: string;
  keyMessage: string;
  origins?: z.infer<typeof briefOriginsSchema>;
};
const unknownBrief = {
  audience: "Аудитория пока не уточнена.",
  decision: "Ожидаемое решение пока не уточнено.",
  keyMessage: "Главную мысль нужно проверить по содержанию и материалам.",
};
/** A draft may start with unknown context. Never label inferred/missing answers as user-confirmed. */
export function resolveBriefing(input?: unknown, fallback?: BriefValues): Briefing {
  const supplied = briefingInputSchema.parse(input ?? {});
  return briefingSchema.parse(Object.fromEntries(briefingFields.map(field => {
    const existing = fallback?.[field]?.trim();
    return [field, supplied[field] ?? {
      value: existing || unknownBrief[field],
      origin: existing ? fallback?.origins?.[field] ?? "assumption" : "assumption",
    }];
  })));
}
export function briefFromBriefing(b: Briefing): BriefValues {
  return {
    audience: b.audience.value,
    decision: b.decision.value,
    keyMessage: b.keyMessage.value,
    origins: {audience: b.audience.origin, decision: b.decision.origin, keyMessage: b.keyMessage.origin},
  };
}
export function editBriefField(brief: BriefValues, field: typeof briefingFields[number], value: string): BriefValues {
  return {...brief, [field]: value, origins: {...brief.origins, [field]: "user"}};
}
