"use client";
import { editBriefField } from "../lib/domain/briefing";
import { useState } from "react";
import { ArrowRight, FileText, MessageSquare, PencilLine } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import type { DeckDoc } from "@/lib/domain/model";
import {
  inspectNarrative,
  roleNames,
  type Brief,
} from "@/lib/domain/narrative";

export function StoryBoard({
  doc,
  revision,
  editable,
  disabled,
  onSlide,
  onSaveBrief,
}: {
  doc: DeckDoc;
  revision: number;
  editable: boolean;
  disabled: boolean;
  onSlide: (index: number) => void;
  onSaveBrief: (brief: Brief, revision: number) => Promise<void>;
}) {
  const [edit, setEdit] = useState<{ brief: Brief; revision: number } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const issues = inspectNarrative(doc);
  return (
    <div className="story-board">
      <div className="workspace-heading">
        <div>
          <span className="eyebrow">ОТ ЗАДАЧИ К РЕШЕНИЮ</span>
          <h2>Логика презентации</h2>
          <p className="hint">
            Что читатель должен понять и почему ему стоит согласиться.
          </p>
        </div>
        {editable && (
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              setError("");
              setEdit({
                brief: structuredClone(
                  doc.brief ?? { audience: "", decision: "", keyMessage: "" },
                ),
                revision,
              });
            }}
          >
            <PencilLine size={16} />
            Уточнить бриф
          </Button>
        )}
      </div>
      <div className="brief-grid">
        {(
          [
            ["Аудитория", doc.brief?.audience],
            ["Ожидаемое решение", doc.brief?.decision],
            ["Главная мысль", doc.brief?.keyMessage],
          ] as const
        ).map(([label, value]) => (
          <div className="brief-card" key={label}>
            <span className="eyebrow">{label}</span>
            <p>{value || "Ещё не сформулировано"}</p>
          </div>
        ))}
      </div>
      {Object.values(doc.brief?.origins || {}).includes("assumption")&&<p className="narrative-warning">В брифе есть рабочие допущения. Это не подтверждённые ответы заказчика.</p>}
      <div className="narrative-summary">
        <FileText size={18} />
        <p>
          <strong>
            {doc.slides.filter((s) => s.intent?.takeaway.trim()).length} из{" "}
            {doc.slides.length}
          </strong>{" "}
          слайдов с явным выводом.{" "}
          {issues.length
            ? `Вопросов к структуре: ${issues.length}.`
            : "Структура заполнена."}{" "}
          <span className="hint">
            Проверка полноты не подтверждает достоверность или убедительность
            аргументов.
          </span>
        </p>
      </div>
      <div className="story-list">
        {doc.slides.map((slide, index) => (
          <button
            key={slide.id}
            className="story-card"
            onClick={() => onSlide(index)}
          >
            <span className="story-number">
              {String(index + 1).padStart(2, "0")}
            </span>
            <div className="min-w-0">
              <span className="eyebrow">
                {slide.intent ? roleNames[slide.intent.role] : "Роль не задана"}
              </span>
              <h3>{slide.title}</h3>
              <p>
                {slide.intent?.takeaway ||
                  "Какой вывод должен сделать читатель? Добавьте его через предложение корректировки или поручите агенту."}
              </p>
              <div className="story-meta">
                <span>
                  <FileText size={13} />
                  {
                    new Set([
                      ...slide.sourceIds,
                      ...slide.metrics.flatMap((m) =>
                        m.sourceId ? [m.sourceId] : [],
                      ),
                    ]).size
                  }{" "}
                  источников
                </span>
                {!!slide.intent?.openQuestions.length && (
                  <span>
                    <MessageSquare size={13} />
                    {slide.intent.openQuestions.length} вопросов
                  </span>
                )}
              </div>
              {slide.intent?.transition && index < doc.slides.length - 1 && (
                <div className="story-bridge">
                  <ArrowRight size={14} />
                  {slide.intent.transition}
                </div>
              )}
              {issues
                .filter((i) => i.slideId === slide.id)
                .map((i) => (
                  <p className="narrative-warning" key={i.code}>
                    {i.message}
                  </p>
                ))}
            </div>
            <ArrowRight className="story-open" size={18} />
          </button>
        ))}
      </div>
      {issues
        .filter((i) => !i.slideId)
        .map((i) => (
          <p className="hint mt-3" key={i.code}>
            {i.message}
          </p>
        ))}
      <Dialog
        open={!!edit}
        onOpenChange={(v) => {
          if (!v && !saving) setEdit(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Бриф презентации</DialogTitle>
            <DialogDescription>
              Бриф сохраняется в версии документа и передаётся агенту вместе со
              слайдами.
            </DialogDescription>
          </DialogHeader>
          {edit && (
            <>
              {(
                [
                  ["audience", "Кто будет читать", 400],
                  ["decision", "Какое решение нужно получить", 800],
                  ["keyMessage", "Что должно остаться в памяти", 800],
                ] as const
              ).map(([key, label, max]) => (
                <label className="field" key={key}>
                  <span>{label}{edit.brief.origins?.[key]==="assumption"?" · Допущение":""}</span>
                  {key === "audience" ? (
                    <Input
                      disabled={saving}
                      value={edit.brief[key]}
                      maxLength={max}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          brief: editBriefField(edit.brief,key,e.target.value),
                        })
                      }
                    />
                  ) : (
                    <Textarea
                      disabled={saving}
                      value={edit.brief[key]}
                      maxLength={max}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          brief: editBriefField(edit.brief,key,e.target.value),
                        })
                      }
                    />
                  )}
                </label>
              ))}
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setEdit(null)}
            >
              Отмена
            </Button>
            <Button
              disabled={saving || !edit}
              onClick={async () => {
                if (!edit) return;
                setSaving(true);
                setError("");
                try {
                  await onSaveBrief(edit.brief, edit.revision);
                  setEdit(null);
                } catch (e) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : "Не удалось сохранить бриф",
                  );
                } finally {
                  setSaving(false);
                }
              }}
            >
              Сохранить бриф
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
