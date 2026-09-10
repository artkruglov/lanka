"use client";
import { useEffect, useRef } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { SlideSources } from "./slide-sources";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  layouts,
  layoutNames,
  uid,
  type Slide,
  type Source,
} from "@/lib/domain/model";
import { narrativeRoles, roleNames } from "@/lib/domain/narrative";
import { recipeGuides } from "@/lib/domain/recipes";

export function SlideInspector({
  slide,
  sources,
  index,
  editable,
  onChange,
  selectedField,
  selectionVersion,
  focusSelection = true,
  onSourceDownload,
}: {
  onSourceDownload?: (source:Source)=>Promise<void>;
  selectedField?: string | null;
  selectionVersion?: number;
  focusSelection?: boolean;
  slide: Slide;
  sources: Source[];
  index: number;
  editable: boolean;
  onChange: (patch: Partial<Slide>, group: string) => void;
}) {
  const inspector = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedField) return;
    const field = Array.from(inspector.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-edit-field]") || []).find(e => e.dataset.editField === selectedField);
    const label = field?.closest(".field");
    label?.classList.add("is-selected-field");
    // A canvas selection highlights its source field without stealing arrow keys or direct typing.
    if (focusSelection) {
      field?.scrollIntoView({block: "nearest"});
      field?.focus({preventScroll: true});
    }
    return () => { label?.classList.remove("is-selected-field"); };
  }, [selectedField, selectionVersion, slide.id, focusSelection]);
  const change = (patch: Partial<Slide>, group: string) =>
    onChange(patch, `${slide.id}:${group}`);
  const intent = slide.intent || {
    role: "context" as const,
    takeaway: "",
    transition: "",
    openQuestions: [],
  };
  const sourcePanel=<SlideSources sources={sources} selected={slide.sourceIds} linked={[...slide.metrics.flatMap(m=>m.sourceId?[m.sourceId]:[]),...(slide.table?.sourceId?[slide.table.sourceId]:[]),...(slide.assetId?[slide.assetId]:[]),...(slide.canvas??[]).flatMap(e=>e.kind==='image'?[e.assetId]:(e.kind==='table'||e.kind==='chart')&&e.data.sourceId?[e.data.sourceId]:[])]} editable={editable} onChange={sourceIds=>change({sourceIds},"sources")} onDownload={onSourceDownload}/>;
  if(slide.canvas)return <div className="slide-properties">
    <div className="panel-section"><h3>Объекты на слайде</h3><p className="hint">Дважды нажмите на текст, чтобы поставить курсор. Перетаскивайте объекты и меняйте размер за угол рамки. Добавляйте текст, фигуры, изображения, таблицы и диаграммы на панели над слайдом. Для таблицы или диаграммы дважды нажмите на объект либо выберите «Данные…».</p>
      <p className="hint">Композиция сохранена вручную. Поля исходного шаблона больше не управляют слайдом. Правки агента появятся в «Изменениях».</p></div>
    {sourcePanel}
    <div className="panel-section"><label className="field"><span>Заметки докладчика</span><Textarea value={slide.notes} maxLength={4000} rows={5} disabled={!editable} onChange={e=>change({notes:e.target.value},"notes")}/></label></div>
  </div>;
  return (
    <div className="slide-properties" ref={inspector}>
      <div className="panel-section">
        <div className="inspector-heading">
          <span className="eyebrow">СЛАЙД {index + 1}</span>
          <span className="hint">
            {editable ? "Редактирование" : "Только просмотр"}
          </span>
        </div>
        <fieldset disabled={!editable}>
          <label className="field">
            <span>Заголовок</span>
            <Textarea
              id="slide-title-field"
              data-edit-field="title"
              rows={2}
              value={slide.title}
              maxLength={180}
              onChange={(e) => change({ title: e.target.value }, "title")}
            />
          </label>
          <label className="field">
            <span>Надзаголовок</span>
            <Input
              data-edit-field="eyebrow"
              value={slide.eyebrow}
              maxLength={80}
              onChange={(e) => change({ eyebrow: e.target.value }, "eyebrow")}
            />
          </label>
          <label className="field">
            <span>Основной текст</span>
            <Textarea
              rows={6}
              data-edit-field="body"
              value={slide.body}
              maxLength={2400}
              onChange={(e) => change({ body: e.target.value }, "body")}
            />
          </label>
          <label className="field">
            <span>Композиция</span>
            <Select
              value={slide.layout}
              disabled={!editable}
              onValueChange={(layout) =>
                change({ layout: layout as Slide["layout"] }, "layout")
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {layouts.map((l) => (
                  <SelectItem key={l} value={l}>
                    {layoutNames[l]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <p className="hint">{recipeGuides[slide.layout].purpose}</p>
        </fieldset>
      </div>
      {slide.layout === "split" && <div className="panel-section">
        <h3>Сравнение</h3>
        {!slide.comparison ? <Button disabled={!editable} onClick={() => change({comparison: {mode:"neutral", before: {label: "Сейчас", text: ""}, after: {label: "Предложено", text: ""}}}, "comparison")}>Добавить сравнение</Button> : <fieldset disabled={!editable}>
          <label className="field"><span>Вид сравнения</span><select aria-label="Вид сравнения" value={slide.comparison.mode??"correction"} onChange={e=>change({comparison:{...slide.comparison!,mode:e.target.value as "neutral"|"correction"}},"comparison:mode")}><option value="neutral">Нейтральное сравнение</option><option value="correction">Исправление текста · с зачёркиванием</option></select></label>
          {(["prompt", "before", "after"] as const).map(part => {
            const pair = slide.comparison![part] ?? {label: "Замечание", text: ""};
            const name = {prompt: "Замечание", before: "Было", after: "Предложено"}[part];
            return <div key={part}>
              <label className="field"><span>{name}: подпись</span><Input data-edit-field={`comparison:${part}:label`} maxLength={40} value={pair.label} onChange={e => change({comparison: {...slide.comparison!, [part]: {...pair, label: e.target.value}}}, `comparison:${part}:label`)} /></label>
              <label className="field"><span>{name}: текст</span><Textarea data-edit-field={`comparison:${part}:text`} maxLength={200} rows={2} value={pair.text} onChange={e => change({comparison: {...slide.comparison!, [part]: {...pair, text: e.target.value}}}, `comparison:${part}:text`)} /></label>
            </div>;
          })}
          {slide.comparison.prompt && <Button variant="ghost" size="sm" onClick={() => change({comparison: {...slide.comparison!, prompt: undefined}}, "comparison")}>Убрать замечание</Button>}
          <label className="field"><span>Статус</span><Input data-edit-field="comparison:status" maxLength={80} value={slide.comparison.status ?? ""} onChange={e => change({comparison: {...slide.comparison!, status: e.target.value}}, "comparison:status")} /></label>
          <Button variant="ghost" onClick={() => change({comparison: undefined}, "comparison")}>Вернуться к двум текстовым блокам</Button>
        </fieldset>}
      </div>}
      {(slide.layout === "metrics" || slide.metrics.length > 0) && (
        <div className="panel-section">
          <h3>Показатели</h3>
          {slide.metrics.map((m, i) => (
            <fieldset disabled={!editable} className="property-card" key={m.id}>
              <div className="row spread">
                <span className="hint">Показатель {i + 1}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Удалить показатель ${i + 1}`}
                  onClick={() =>
                    change(
                      { metrics: slide.metrics.filter((x) => x.id !== m.id) },
                      "metrics",
                    )
                  }
                >
                  <Trash2 size={14} />
                </Button>
              </div>
              <label className="field">
                <span>Подпись</span>
                <Input
                  data-edit-field={`metric:${m.id}:label`}
                  value={m.label}
                  maxLength={70}
                  onChange={(e) =>
                    change(
                      {
                        metrics: slide.metrics.map((x) =>
                          x.id === m.id ? { ...x, label: e.target.value } : x,
                        ),
                      },
                      `metric:${m.id}:label`,
                    )
                  }
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="field">
                  <span>Значение</span>
                  <Input
                    type="number"
                    step="any"
                    data-edit-field={`metric:${m.id}:value`}
                    value={m.value}
                    onChange={(e) => {
                      if (Number.isFinite(e.target.valueAsNumber))
                        change(
                          {
                            metrics: slide.metrics.map((x) =>
                              x.id === m.id
                                ? { ...x, value: e.target.valueAsNumber }
                                : x,
                            ),
                          },
                          `metric:${m.id}:value`,
                        );
                    }}
                  />
                </label>
                <label className="field">
                  <span>Единица</span>
                  <Input
                    data-edit-field={`metric:${m.id}:unit`}
                    value={m.unit}
                    maxLength={20}
                    onChange={(e) =>
                      change(
                        {
                          metrics: slide.metrics.map((x) =>
                            x.id === m.id ? { ...x, unit: e.target.value } : x,
                          ),
                        },
                        `metric:${m.id}:unit`,
                      )
                    }
                  />
                </label>
              </div>
            </fieldset>
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={!editable || slide.metrics.length >= 4}
            onClick={() =>
              change(
                {
                  metrics: [
                    ...slide.metrics,
                    { id: uid(), label: "Показатель", value: 0, unit: "" },
                  ],
                },
                "metrics",
              )
            }
          >
            <Plus size={14} />
            Добавить показатель
          </Button>
        </div>
      )}
      {slide.layout === "table" && <div className="panel-section">
        <h3>Таблица</h3>
        {!slide.table ? <Button disabled={!editable} onClick={() => change({table: {columns: ["Критерий", "Вариант А", "Вариант Б"], rows: [["Первый критерий", "", ""]]}}, "table")}>Добавить таблицу</Button> : <>
          {slide.table.columns.map((v,j) => <label className="field" key={j}><span>Колонка {j+1}</span><Input data-edit-field={`table:column:${j}`} disabled={!editable} value={v} maxLength={60} onChange={e => change({table: {...slide.table!, columns: slide.table!.columns.map((c,k)=>k===j?e.target.value:c)}}, `table:column:${j}`)}/></label>)}
          {slide.table.rows.map((row,i) => <fieldset key={i} className="mb-4"><legend className="hint">Строка {i+1}</legend>{row.map((v,j)=><label className="field" key={j}><span>{slide.table!.columns[j]}</span><Textarea data-edit-field={`table:${i}:${j}`} rows={2} disabled={!editable} value={v} maxLength={160} onChange={e => change({table:{...slide.table!,rows:slide.table!.rows.map((r,k)=>k===i?r.map((c,l)=>l===j?e.target.value:c):r)}},`table:${i}:${j}`)}/></label>)}<Button size="sm" variant="ghost" disabled={!editable || slide.table!.rows.length <= 1} onClick={()=>change({table:{...slide.table!,rows:slide.table!.rows.filter((_,k)=>k!==i)}},"table")}>Удалить строку</Button></fieldset>)}
          <Button variant="outline" disabled={!editable || slide.table.rows.length >= 6} onClick={()=>change({table:{...slide.table!,rows:[...slide.table!.rows,slide.table!.columns.map(()=>"")]}},"table")}>Добавить строку</Button>
          <p className="hint mt-3">До 6 строк. Длинные пояснения вынесите в заметки.</p>
        </>}
      </div>}
      {slide.layout === "chart" && (
        <div className="panel-section">
          <h3>Данные диаграммы</h3>
          <fieldset disabled={!editable}>
            <label className="field">
              <span>Единица измерения</span>
              <Input
                value={slide.chartUnit}
                maxLength={20}
                onChange={(e) =>
                  change({ chartUnit: e.target.value }, "chartUnit")
                }
              />
            </label>
            {slide.chart.map((point, i) => (
              <div className="chart-property-row" key={i}>
                <Input
                  aria-label={`Категория ${i + 1}`}
                  data-edit-field={`chart:${i}:label`}
                  value={point.label}
                  maxLength={50}
                  onChange={(e) =>
                    change(
                      {
                        chart: slide.chart.map((x, j) =>
                          j === i ? { ...x, label: e.target.value } : x,
                        ),
                      },
                      `chart:${i}:label`,
                    )
                  }
                />
                <Input
                  aria-label={`Значение категории ${i + 1}`}
                  type="number"
                  step="any"
                  data-edit-field={`chart:${i}:value`}
                  value={point.value}
                  onChange={(e) => {
                    if (Number.isFinite(e.target.valueAsNumber))
                      change(
                        {
                          chart: slide.chart.map((x, j) =>
                            j === i
                              ? { ...x, value: e.target.valueAsNumber }
                              : x,
                          ),
                        },
                        `chart:${i}:value`,
                      );
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Удалить категорию ${i + 1}`}
                  onClick={() =>
                    change(
                      { chart: slide.chart.filter((_, j) => j !== i) },
                      "chart",
                    )
                  }
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              disabled={slide.chart.length >= 8}
              onClick={() =>
                change(
                  { chart: [...slide.chart, { label: "Категория", value: 0 }] },
                  "chart",
                )
              }
            >
              <Plus size={14} />
              Добавить категорию
            </Button>
          </fieldset>
        </div>
      )}
      {slide.layout === "image" && (
        <div className="panel-section">
          <label className="field">
            <span>Изображение</span>
            <Select
              value={slide.assetId || "none"}
              disabled={!editable}
              onValueChange={(assetId) =>
                change(
                  { assetId: assetId === "none" ? undefined : assetId },
                  "asset",
                )
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Выберите файл" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Без изображения</SelectItem>
                {sources
                  .filter((s) => s.kind === "image" && !s.image?.normalizedSourceId)
                  .map((s) => (
                    <SelectItem value={s.id} key={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </label>
        </div>
      )}
      <details className="panel-section">
        <summary>Логика слайда</summary>
        <fieldset disabled={!editable} className="mt-4">
          <label className="field">
            <span>Роль в аргументации</span>
            <Select
              value={intent.role}
              disabled={!editable}
              onValueChange={(role) =>
                change(
                  { intent: { ...intent, role: role as typeof intent.role } },
                  "role",
                )
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
            <span>Главный вывод</span>
            <Textarea
              value={intent.takeaway}
              maxLength={800}
              onChange={(e) =>
                change(
                  { intent: { ...intent, takeaway: e.target.value } },
                  "takeaway",
                )
              }
            />
          </label>
          <label className="field">
            <span>Переход к следующему слайду</span>
            <Textarea
              value={intent.transition}
              maxLength={800}
              onChange={(e) =>
                change(
                  { intent: { ...intent, transition: e.target.value } },
                  "transition",
                )
              }
            />
          </label>
        </fieldset>
      </details>
      {sourcePanel}
      <div className="panel-section">
        <label className="field">
          <span>Заметки выступающего</span>
          <Textarea
            rows={4}
            disabled={!editable}
            value={slide.notes}
            maxLength={4000}
            onChange={(e) => change({ notes: e.target.value }, "notes")}
          />
        </label>
      </div>
    </div>
  );
}
