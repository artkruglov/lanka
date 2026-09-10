"use client";
import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select";
import { SlideCanvas } from "./slide-canvas";
import {
  layouts,
  layoutNames,
  uid,
  slideSchema,
  type Slide,
  type Brand,
  type DeckDoc,
  type Source,
} from "@/lib/domain/model";
import { narrativeRoles, roleNames } from "@/lib/domain/narrative";
import { recipeGuides } from "@/lib/domain/recipes";
import { parseCsv } from "@/lib/domain/intake";
import { scene } from "@/lib/domain/scene";

export function CorrectionDialog({
  slide,
  brand,
  design,
  sources,
  onClose,
  onSubmit,
}: {
  slide: Slide;
  brand: Brand;
  design?: DeckDoc["design"];
  sources: Source[];
  onClose: () => void;
  onSubmit: (after: Slide, title: string) => Promise<void>;
}) {
  const [after, setAfter] = useState(() => structuredClone(slide));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const patch = (v: Partial<Slide>) => setAfter((s) => ({ ...s, ...v }));
  const intent = after.intent ?? {
    role: "context" as const,
    takeaway: "",
    transition: "",
    openQuestions: [],
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !saving) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[1040px] max-h-[92svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Предложить корректировку</DialogTitle>
          <DialogDescription>
            Подготовьте точный вариант и объясните причину. Презентация
            изменится после принятия предложения.
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={saving} className="contents">
          <div className="correction-grid">
            <div>
              <Tabs defaultValue="meaning">
                <TabsList className="w-full">
                  <TabsTrigger value="meaning">Содержание</TabsTrigger>
                  <TabsTrigger value="logic">Логика</TabsTrigger>
                  <TabsTrigger value="design">Композиция</TabsTrigger>
                </TabsList>
                <TabsContent value="meaning">
                  <label className="field">
                    <span>Заголовок</span>
                    <Textarea
                      value={after.title}
                      maxLength={180}
                      onChange={(e) => patch({ title: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Текст</span>
                    <Textarea
                      className="min-h-32"
                      value={after.body}
                      maxLength={2400}
                      onChange={(e) => patch({ body: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Надзаголовок</span>
                    <Input
                      value={after.eyebrow}
                      maxLength={80}
                      onChange={(e) => patch({ eyebrow: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Заметки выступающего</span>
                    <Textarea
                      value={after.notes}
                      maxLength={4000}
                      onChange={(e) => patch({ notes: e.target.value })}
                    />
                  </label>
                  {after.layout === "metrics" && (
                    <div className="stack">
                      <h3>Показатели</h3>
                      {after.metrics.map((m, i) => (
                        <div className="rounded-lg border p-3" key={m.id}>
                          <Input
                            aria-label={`Название показателя ${i + 1}`}
                            value={m.label}
                            maxLength={70}
                            onChange={(e) =>
                              patch({
                                metrics: after.metrics.map((v, j) =>
                                  j === i ? { ...v, label: e.target.value } : v,
                                ),
                              })
                            }
                          />
                          <div className="row mt-2">
                            <Input
                              type="number"
                              aria-label={`Значение ${i + 1}`}
                              value={m.value}
                              onChange={(e) =>
                                patch({
                                  metrics: after.metrics.map((v, j) =>
                                    j === i
                                      ? { ...v, value: Number(e.target.value) }
                                      : v,
                                  ),
                                })
                              }
                            />
                            <Input
                              aria-label={`Единица ${i + 1}`}
                              value={m.unit}
                              maxLength={20}
                              onChange={(e) =>
                                patch({
                                  metrics: after.metrics.map((v, j) =>
                                    j === i
                                      ? { ...v, unit: e.target.value }
                                      : v,
                                  ),
                                })
                              }
                            />
                            <Button
                              variant="ghost"
                              aria-label={`Удалить показатель ${i + 1}`}
                              onClick={() =>
                                patch({
                                  metrics: after.metrics.filter(
                                    (_, j) => j !== i,
                                  ),
                                })
                              }
                            >
                              ×
                            </Button>
                          </div>
                        </div>
                      ))}
                      <Button
                        variant="outline"
                        disabled={after.metrics.length >= 4}
                        onClick={() =>
                          patch({
                            metrics: [
                              ...after.metrics,
                              {
                                id: uid(),
                                label: "Показатель",
                                value: 0,
                                unit: "",
                              },
                            ],
                          })
                        }
                      >
                        Добавить показатель
                      </Button>
                    </div>
                  )}
                  {after.layout === "chart" && (
                    <div className="stack">
                      <h3>Данные диаграммы</h3>
                      <label className="field">
                        <span>Импорт CSV: категория, число</span>
                        <Input
                          type="file"
                          accept=".csv,text/csv"
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            e.target.value = "";
                            if (!file) return;
                            try {
                              if (file.size > 100_000)
                                throw new Error(
                                  "CSV должен быть меньше 100 КБ.",
                                );
                              patch({ chart: parseCsv(await file.text()) });
                              setError("");
                            } catch (err) {
                              setError(
                                err instanceof Error
                                  ? err.message
                                  : "Не удалось прочитать CSV",
                              );
                            }
                          }}
                        />
                      </label>
                      <Input
                        aria-label="Единицы диаграммы"
                        placeholder="Единицы измерения"
                        maxLength={20}
                        value={after.chartUnit}
                        onChange={(e) => patch({ chartUnit: e.target.value })}
                      />
                      {after.chart.map((p, i) => (
                        <div className="row" key={i}>
                          <Input
                            aria-label={`Категория ${i + 1}`}
                            maxLength={50}
                            value={p.label}
                            onChange={(e) =>
                              patch({
                                chart: after.chart.map((v, j) =>
                                  i === j ? { ...v, label: e.target.value } : v,
                                ),
                              })
                            }
                          />
                          <Input
                            type="number"
                            aria-label={`Значение категории ${i + 1}`}
                            value={p.value}
                            onChange={(e) =>
                              patch({
                                chart: after.chart.map((v, j) =>
                                  i === j
                                    ? { ...v, value: Number(e.target.value) }
                                    : v,
                                ),
                              })
                            }
                          />
                          <Button
                            variant="ghost"
                            aria-label={`Удалить категорию ${i + 1}`}
                            onClick={() =>
                              patch({
                                chart: after.chart.filter((_, j) => i !== j),
                              })
                            }
                          >
                            ×
                          </Button>
                        </div>
                      ))}
                      <Button
                        variant="outline"
                        disabled={after.chart.length >= 8}
                        onClick={() =>
                          patch({
                            chart: [
                              ...after.chart,
                              { label: "Категория", value: 0 },
                            ],
                          })
                        }
                      >
                        Добавить категорию
                      </Button>
                    </div>
                  )}
                  <h3 className="mt-4">Источники</h3>
                  {!sources.length && (
                    <p className="hint">
                      Прикрепите материалы в контексте слайда.
                    </p>
                  )}
                  {sources.map((s) => (
                    <label className="row text-sm mb-2" key={s.id}>
                      <Checkbox
                        checked={after.sourceIds.includes(s.id)}
                        onCheckedChange={(v) =>
                          patch({
                            sourceIds: v
                              ? [...after.sourceIds, s.id]
                              : after.sourceIds.filter((id) => id !== s.id),
                          })
                        }
                      />
                      {s.name}
                    </label>
                  ))}
                </TabsContent>
                <TabsContent value="logic">
                  <label className="field">
                    <span>Роль в аргументации</span>
                    <Select
                      value={intent.role}
                      onValueChange={(v) =>
                        patch({
                          intent: { ...intent, role: v as typeof intent.role },
                        })
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {narrativeRoles.map((r) => (
                          <SelectItem key={r} value={r}>
                            {roleNames[r]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="field">
                    <span>Вывод читателя</span>
                    <Textarea
                      value={intent.takeaway}
                      maxLength={800}
                      placeholder="Какую мысль доказывает этот слайд?"
                      onChange={(e) =>
                        patch({
                          intent: { ...intent, takeaway: e.target.value },
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Переход к следующему слайду</span>
                    <Textarea
                      value={intent.transition}
                      maxLength={800}
                      placeholder="Почему следующая мысль следует из этой?"
                      onChange={(e) =>
                        patch({
                          intent: { ...intent, transition: e.target.value },
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Открытые вопросы — по одному на строке</span>
                    <Textarea
                      value={intent.openQuestions.join("\n")}
                      onChange={(e) =>
                        patch({
                          intent: {
                            ...intent,
                            openQuestions: e.target.value.split("\n"),
                          },
                        })
                      }
                    />
                  </label>
                  <p className="hint">
                    Это явный план аргументации. Он требует проверки человеком;
                    заполненность полей не доказывает правильность выводов.
                  </p>
                </TabsContent>
                <TabsContent value="design">
                  <div className="recipe-list">
                    {layouts.map((l) => (
                      <button
                        className={`recipe-option ${l === after.layout ? "selected" : ""}`}
                        aria-pressed={l === after.layout}
                        key={l}
                        onClick={() => patch({ layout: l })}
                      >
                        <strong>{layoutNames[l]}</strong>
                        <span>{recipeGuides[l].purpose}</span>
                      </button>
                    ))}
                  </div>
                  {after.layout === "image" && (
                    <Select
                      value={after.assetId || "none"}
                      onValueChange={(v) =>
                        patch({ assetId: v === "none" ? undefined : v })
                      }
                    >
                      <SelectTrigger className="w-full mt-4">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">
                          Выберите изображение
                        </SelectItem>
                        {sources
                          .filter((s) => s.kind === "image" && !s.image?.normalizedSourceId)
                          .map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  )}
                </TabsContent>
              </Tabs>
            </div>
            <div className="correction-preview">
              <span className="eyebrow">ПРЕДЛОЖЕННЫЙ ВАРИАНТ</span>
              <SlideCanvas slide={after} brand={brand} design={design} />
              <h3 className="mt-4">{layoutNames[after.layout]}</h3>
              <p className="hint">{recipeGuides[after.layout].budget}</p>
              {scene(after, brand, 0, 1, design).overflow && (
                <p className="narrative-warning">
                  Контент не помещается в композицию или не соответствует её
                  ограничениям.
                </p>
              )}
              <label className="field mt-6">
                <span>Зачем нужна корректировка</span>
                <Textarea
                  value={reason}
                  maxLength={140}
                  placeholder="Например: отделить вывод от доказательств"
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            </div>
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Отмена
          </Button>
          <Button
            disabled={
              saving ||
              !reason.trim() ||
              JSON.stringify(slide) === JSON.stringify(after)
            }
            onClick={async () => {
              setSaving(true);
              setError("");
              try {
                const candidate = structuredClone(after);
                if (candidate.intent)
                  candidate.intent.openQuestions =
                    candidate.intent.openQuestions
                      .map((q) => q.trim())
                      .filter(Boolean);
                await onSubmit(slideSchema.parse(candidate), reason.trim());
                onClose();
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : "Не удалось отправить предложение",
                );
              } finally {
                setSaving(false);
              }
            }}
          >
            Отправить на проверку
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
