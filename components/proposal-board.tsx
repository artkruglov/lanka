import {BriefProposalReview} from './brief-proposal-review';
"use client";
import { useEffect, useState } from "react";
import {sourceReviewWarnings} from "@/lib/domain/source-review";
import { Check } from "lucide-react";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { SlideCanvas } from "./slide-canvas";
import type { Deck, DeckDoc, Slide } from "@/lib/domain/model";
import { roleNames } from "@/lib/domain/narrative";
import { W, H } from "@/lib/domain/scene";
import { reviewObjects, reviewPreview, type ReviewObject } from "@/lib/project/review-preview";
import { objectChanges, canAcceptChange, reviewStatus, type ProposalChange } from "@/lib/domain/object-review";
import { canonicalJson } from "@/lib/domain/canonical-json";

const objectCardId=(changeId:string,id:string)=>`review-object-${changeId}-${id}`;
function reveal(id:string){const element=document.getElementById(id);element?.scrollIntoView({block:"nearest"});element?.focus({preventScroll:true});}

function ObjectChanges({change,current,disabled,onDecide,activeId,onLocate,items,sourceWarning}:{sourceWarning?:string;change:ProposalChange;current:Slide|undefined;disabled:boolean;onDecide:(id:string,decision:"accepted"|"rejected")=>void;activeId?:string;onLocate?:(id:string)=>void;items?:ReviewObject[]}) {
  const objects=items??reviewObjects(change,current);
  if(!objects.length)return null;
  const cards=(items:ReviewObject[])=>items.map(item=><article className={`review-object-card${activeId===item.id?" is-active":""}`} tabIndex={-1} id={objectCardId(change.id,item.id)} key={item.id}>
    <div className="review-object-heading"><span className="review-object-number">{item.number}</span><strong title={item.label}>{item.label.slice(0,100)}</strong>{onLocate&&item.status==="pending"&&<button type="button" onClick={()=>onLocate(item.id)}>На слайде</button>}</div>
    <p className="hint">{item.reasons.join(" · ")}</p>
    {item.before?.kind==="text"&&item.after?.kind==="text"&&item.before.text!==item.after.text&&<div className="review-text-diff"><p><small>Было</small><br/><del>{item.before.text||"—"}</del></p><p><small>Предложено</small><br/><ins>{item.after.text||"—"}</ins></p></div>}
    {item.status!=="pending"?<p className="hint">{item.status==="accepted"?"Принято":"Отклонено"}</p>:item.independent?<>
      {item.conflict&&<p className="narrative-warning">{item.conflict}</p>}
      <div className="row mt-3"><Button size="sm" variant="outline" disabled={disabled||!!item.conflict||!!sourceWarning} title={sourceWarning||item.conflict||undefined} onClick={()=>onDecide(item.id,"accepted")}>Принять № {item.number}</Button><Button size="sm" variant="ghost" disabled={disabled} onClick={()=>onDecide(item.id,"rejected")}>Отклонить</Button></div>
    </>:<p className="hint">Принимается вместе со слайдом.</p>}
  </article>);
  const pending=objects.filter(o=>o.status==="pending"),decided=objects.filter(o=>o.status!=="pending");
  return <div className="review-object-list">{cards(pending)}{!!decided.length&&<details><summary>Уже рассмотрено · {decided.length}</summary>{cards(decided)}</details>}</div>;
}

function ReviewImage({slide,deck,index,objects,activeId,onSelect,showMarks}:{slide:Slide;deck:Deck;index:number;objects:ReviewObject[];activeId?:string;onSelect:(id:string)=>void;showMarks:boolean}) {
  const marks=(showMarks?objects:[]).filter(o=>o.status==="pending").flatMap(item=>{const element=slide.canvas?.find(e=>e.id===item.id);return element?[{item,element}]:[];});
  return <div className="review-preview-image">
    <SlideCanvas slide={slide} brand={deck.state.doc.brand} design={deck.state.doc.design} index={index} total={deck.state.doc.slides.length}/>
    <svg className="review-overlay" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">{marks.map(({item,element:e})=><rect key={item.id} x={e.x} y={e.y} width={e.w} height={e.h} fill="none" stroke={activeId===item.id?"#4333ad":"#8270db"} strokeWidth={activeId===item.id?3:1.5} strokeDasharray={activeId===item.id?undefined:"5 3"} vectorEffect="non-scaling-stroke"/>)}</svg>
    {marks.map(({item,element:e})=><button key={item.id} type="button" className={`review-marker${activeId===item.id?" is-active":""}`} style={{left:`clamp(0px, ${e.x/W*100}%, calc(100% - 28px))`,top:`clamp(0px, ${e.y/H*100}%, calc(100% - 28px))`}} aria-label={`Правка ${item.number}: ${item.label.slice(0,100)}`} aria-pressed={activeId===item.id} onClick={()=>onSelect(item.id)}>{item.number}</button>)}
  </div>;
}

function DraftSlidesPreview({doc}:{doc:DeckDoc}){
  const [selected,setSelected]=useState(doc.slides[0].id),[all,setAll]=useState(false);
  const index=Math.max(0,doc.slides.findIndex(s=>s.id===selected));
  const choose=(id:string)=>{setAll(!id);if(id)setSelected(id);};
  return <>
    {doc.slides.length>1&&<nav className="review-slide-navigation" aria-label="Слайды предложенной презентации">
      <button type="button" aria-label="Предыдущий предложенный слайд" disabled={all||index===0} onClick={()=>choose(doc.slides[index-1].id)}>←</button>
      <label>Просмотр слайдов<select aria-label="Предложенный слайд" value={all?'':doc.slides[index].id} onChange={e=>choose(e.target.value)}>
        {doc.slides.map((slide,i)=><option key={slide.id} value={slide.id}>{i+1}/{doc.slides.length} · {slide.title}</option>)}
        <option value="">Все слайды · {doc.slides.length}</option>
      </select></label>
      <button type="button" aria-label="Следующий предложенный слайд" disabled={all||index===doc.slides.length-1} onClick={()=>choose(doc.slides[index+1].id)}>→</button>
    </nav>}
    {doc.slides.flatMap((slide,i)=>all||i===index?[<div className="review-change" key={slide.id}><h4 aria-live="polite">Слайд {i+1} · {slide.title}</h4><SlideCanvas slide={slide} brand={doc.brand} design={doc.design} index={i} total={doc.slides.length}/></div>]:[])}
  </>;
}

export function ProposalBoard({
  deck,
  disabled,
  onAction,
  focusedProposalId,
  focusedSlideId,
  onSelectSlide,
  onShowAll,
}: {
  deck: Deck;
  disabled: boolean;
  focusedProposalId?: string | null;
  focusedSlideId?: string;
  onSelectSlide?: (id:string)=>void;
  onShowAll?: () => void;
  onAction: (
    action: string,
    payload: Record<string, unknown>,
    message: string,
  ) => void;
}) {
  const [sourceReview,setSourceReview]=useState<{state:Deck['state'];warnings:Record<string,string>}|null>(null);
  useEffect(()=>{let current=true;sourceReviewWarnings(deck.state).then(warnings=>{if(current)setSourceReview({state:deck.state,warnings});});return()=>{current=false;};},[deck.state]);
  const sourceWarning=(c:ProposalChange)=>c.sourceDependencies?.length?(sourceReview?.state===deck.state?sourceReview.warnings[c.id]:"Проверяем источники предложения…"):undefined;
  const acceptable=(c:ProposalChange)=>!sourceWarning(c)&&canAcceptChange(deck.state.doc.slides.find(s=>s.id===c.slideId),c);
  const [selected, setSelected] = useState<string[]>([]);
  const [showMarks,setShowMarks]=useState(false);
  const [comparison,setComparison]=useState<"both"|"before"|"after">(()=>typeof window!=="undefined"&&document.body.dataset.ui==="refresh"&&window.matchMedia("(max-width: 760px)").matches?"after":"both");
  const [activeObject,setActiveObject]=useState<{changeId:string;id:string}|null>(null);
  const [showAllChanges,setShowAllChanges]=useState<Record<string,boolean>>({});
  const [chosenChanges,setChosenChanges]=useState<Record<string,string>>({});
  useEffect(()=>{
    if(sourceReview?.state!==deck.state)return;
    const valid=new Set(deck.state.proposals.flatMap(p=>p.status==="pending"?p.changes.filter(c=>c.status==="pending"&&acceptable(c)).map(c=>c.id):[]));
    setSelected(old=>old.every(id=>valid.has(id))?old:old.filter(id=>valid.has(id)));
  },[deck.state.proposals,deck.state.doc.slides,sourceReview]);
  const visible = deck.state.proposals.filter(p=>!focusedProposalId||p.id===focusedProposalId);
  const proposals = visible.filter((p) => p.status === "pending");
  useEffect(()=>{
    const pending=deck.state.proposals.filter(p=>p.status==='pending'&&(!focusedProposalId||p.id===focusedProposalId)).flatMap(p=>p.changes.filter(c=>c.status==='pending'));
    if(pending.length&&!pending.some(c=>c.slideId===focusedSlideId))onSelectSlide?.(pending[0].slideId);
  },[deck.state.proposals,focusedProposalId,focusedSlideId,onSelectSlide]);
  return (
    <div className="proposal-board">
      <div className="workspace-heading">
        <div>
          <h2>Проверка изменений</h2>
          <p className="hint">
            Сравните варианты. Правки появятся в презентации после принятия.
          </p>
        </div>
      </div>
      {proposals.some(p=>!p.draftCandidate&&!p.briefChanges)&&<div className="review-view-controls" role="group" aria-label="Режим сравнения">{([["both","Рядом"],["before","До"],["after","После"]] as const).map(([mode,label])=><button type="button" key={mode} aria-pressed={comparison===mode} onClick={()=>setComparison(mode)}>{label}</button>)}<button type="button" aria-pressed={showMarks} onClick={()=>setShowMarks(v=>!v)}>{showMarks?"Скрыть отметки":"Показать отметки"}</button></div>}
      {focusedProposalId&&deck.state.proposals.length>1&&<Button variant="ghost" size="sm" onClick={onShowAll}>Все предложения</Button>}
      {!proposals.length && !focusedProposalId && (
        <div className="review-empty">
          <Check size={28} />
          <h3>Нет изменений, ожидающих решения</h3>
          <p>
            Поручите агенту доработку презентации. Здесь появится предложение для проверки.
          </p>
        </div>
      )}
      {visible.some(p => p.status !== "pending") && <details className="panel-section mb-4" open={focusedProposalId?true:undefined}>
        <summary>История рассмотренных предложений · {visible.filter(p => p.status !== "pending").length}</summary>
        {visible.filter(p => p.status !== "pending").map(p => p.briefChanges?<BriefProposalReview key={p.id} proposal={p} current={deck.state.doc.brief} disabled onAction={onAction}/>:<div className="property-card mt-3" key={p.id}>
          <strong>{p.title}</strong><p className="hint">{p.author === "local-agent" ? "Агент" : p.author} · {p.draftCandidate?`Первое заполнение: ${p.changes[0]?.status==="accepted"?"принято":"отклонено"}`:<>слайдов с принятыми правками: {p.changes.filter(c => c.status === "accepted").length} · отклонено: {p.changes.filter(c => c.status === "rejected").length}</>}</p>
          {p.draftCandidate&&<details><summary>Предложенная презентация · слайдов: {p.draftCandidate.after.slides.length}</summary><DraftSlidesPreview doc={p.draftCandidate.after}/></details>}
          {!p.draftCandidate&&p.changes.map(c => <details key={c.id} open={focusedProposalId===p.id?true:undefined}><summary>{c.after.title} · {reviewStatus(c)}</summary><div className="review-pair">{([["Было",c.before],["Предложено",c.after]] as const).map(([label,slide]) => <div key={label}><span className="eyebrow">{label}</span><SlideCanvas slide={slide} brand={deck.state.doc.brand} design={deck.state.doc.design} total={deck.state.doc.slides.length}/></div>)}</div>{c.objectDecisions&&<details className="mt-3"><summary>Решения по объектам</summary><ObjectChanges change={c} current={deck.state.doc.slides.find(s=>s.id===c.slideId)} disabled={true} onDecide={()=>{}}/></details>}</details>)}
        </div>)}
      </details>}
      {proposals.map((p) => {
        if(p.briefChanges)return <BriefProposalReview key={p.id} proposal={p} current={deck.state.doc.brief} disabled={disabled||deck.role==='viewer'} onAction={onAction}/>;
        if(p.draftCandidate){
          const candidate=p.draftCandidate;
          const conflict=deck.state.revision!==p.baseRevision||canonicalJson(deck.state.doc)!==canonicalJson(candidate.before);
          const warning=p.changes.map(sourceWarning).find(Boolean);
          return <section className="review-proposal" key={p.id}>
            <h3>{p.title}</h3><p className="hint">{p.author} · первое заполнение · слайдов: {candidate.after.slides.length}</p>
            <p>Проверьте всю презентацию. После принятия слайды появятся в этом документе; затем их можно править по отдельности.</p>
            {conflict&&<p role="status" className="narrative-warning">Заготовка изменилась. Попросите агента подготовить правки к текущей версии.</p>}
            {warning&&<p role="status" className="narrative-warning">{warning}</p>}
            <details><summary>Исходная заготовка</summary><SlideCanvas slide={candidate.before.slides[0]} brand={candidate.before.brand} design={candidate.before.design} total={1}/></details>
            <DraftSlidesPreview doc={candidate.after}/>
            <div className="row mt-4 review-actions"><Button disabled={disabled||deck.role==='viewer'||conflict||!!warning} onClick={()=>onAction('accept',{proposalId:p.id,changeIds:p.changes.map(c=>c.id)},'Презентация заполнена')}>Принять презентацию ({candidate.after.slides.length})</Button><Button variant="outline" disabled={disabled||deck.role==='viewer'} onClick={()=>onAction('reject',{proposalId:p.id},'Предложение отклонено')}>Отклонить заполнение</Button></div>
          </section>;
        }
        const pending=p.changes.filter(c=>c.status==='pending');
        const focused=pending.find(c=>c.slideId===focusedSlideId)??pending.find(c=>c.id===chosenChanges[p.id])??pending[0];
        const position=pending.findIndex(c=>c.id===focused?.id);
        const choose=(id:string)=>{setShowAllChanges(v=>({...v,[p.id]:!id}));if(id){setChosenChanges(v=>({...v,[p.id]:id}));const c=pending.find(c=>c.id===id);if(c)onSelectSlide?.(c.slideId);}};
        return (
        <section className="review-proposal" key={p.id}>
          <div className="workspace-heading">
            <div>
              <h3>{p.title}</h3>
              <p className="hint">
                {p.author === "local-agent" ? "Агент" : p.author} · основано на версии {p.baseRevision}
              </p>
            </div>
            <span className="status review">На проверке</span>
          </div>
          <Button
            className="mb-4"
            title={p.changes.some(c=>c.status==="pending"&&!acceptable(c))?"Есть конфликт. Проверьте отдельные правки ниже или попросите агента обновить предложение.":undefined}
            disabled={disabled || deck.role === "viewer" || !p.changes.some(c => c.status === "pending") ||
              p.changes.some(c => c.status === "pending" && !acceptable(c))}
            onClick={() => onAction("accept", {
              proposalId: p.id,
              changeIds: p.changes.filter(c => c.status === "pending").map(c => c.id),
            }, "Все оставшиеся правки приняты")}
          >
            <Check size={16}/>
            Принять оставшиеся правки · слайдов {p.changes.filter(c => c.status === "pending").length}
          </Button>
          {(p.feedbackIds || []).map(id => <blockquote className="project-reply mb-4" key={id}>{deck.state.comments.find(c=>c.id===id)?.text}</blockquote>)}
          {pending.length>1&&<nav className="review-slide-navigation" aria-label={`Слайды предложения: ${p.title}`}>
            <button type="button" aria-label="Предыдущий слайд с правками" disabled={showAllChanges[p.id]||position<=0} onClick={()=>choose(pending[position-1].id)}>←</button>
            <label>Просмотр изменений<select aria-label={`Перейти к правкам: ${p.title}`} value={showAllChanges[p.id]?"":focused?.id??""} onChange={e=>choose(e.target.value)}>
              {pending.map((c,i)=>{const n=deck.state.doc.slides.findIndex(s=>s.id===c.slideId);return <option key={c.id} value={c.id}>{i+1}/{pending.length} · {n>=0?`Слайд ${n+1}`:'Удалённый слайд'} · {c.after.title}</option>;})}
              <option value="">Все изменения · {pending.length}</option>
            </select></label>
            <button type="button" aria-label="Следующий слайд с правками" disabled={showAllChanges[p.id]||position>=pending.length-1} onClick={()=>choose(pending[position+1].id)}>→</button>
          </nav>}
          {p.changes
            .filter((c) => c.status === "pending"&&(showAllChanges[p.id]||c.id===focused?.id))
            .map((c) => {
              const index = deck.state.doc.slides.findIndex(
                (s) => s.id === c.slideId,
              );
              const current = deck.state.doc.slides[index];
              const preview=reviewPreview(c,current),stale=preview.conflicted;
              const granular=objectChanges(c),objects=reviewObjects(c,current);
              const activeId=activeObject?.changeId===c.id?activeObject.id:undefined;
              const selectObject=(id:string)=>{setActiveObject({changeId:c.id,id});reveal(objectCardId(c.id,id));};
              return (
                <div className="review-change" key={c.id}>
                  <label className="row mb-3">
                    <Checkbox
                      aria-label={`Выбрать правки слайда ${index+1}`}
                      checked={selected.includes(c.id)}
                      disabled={disabled || stale || !!sourceWarning(c) || deck.role === "viewer"}
                      onCheckedChange={(v) =>
                        setSelected((all) =>
                          v ? [...all, c.id] : all.filter((id) => id !== c.id),
                        )
                      }
                    />
                    <strong>
                      {index >= 0 ? `Слайд ${index + 1}` : "Удалённый слайд"} ·{" "}
                      {c.after.title}
                    </strong>
                  </label>
                  {sourceWarning(c)&&<p role="status" className="narrative-warning">{sourceWarning(c)}</p>}
                  {stale && (
                    <p className="narrative-warning">
                      Есть конфликт. Ниже показано исходное предложение, а не результат для текущей версии. Независимые объекты можно принять отдельно.
                    </p>
                  )}
                  <p className="hint mb-3">Изменено: {([
                    ["title","Заголовок"],["body","Текст"],["intent","Логика и вывод"],["layout","Композиция"],
                    ["metrics","Показатели"],["chart","График"],["table","Таблица"],["sourceIds","Источники"],
                    ["assetId","Изображение"],["notes","Заметки"],["eyebrow","Рубрика"],["chartUnit","Единицы"],["comparison","Сравнение"],["canvas","Объекты слайда"]
                  ] as const).filter(([key])=>canonicalJson(c.before[key])!==canonicalJson(c.after[key])).map(([,label])=>label).join(" · ")}</p>
                  {!granular&&(["title","body"] as const).filter(key=>c.before[key]!==c.after[key]).map(key=><div className="review-text-diff" key={key}><p><small>{key==="title"?"Заголовок":"Текст"} · было</small><br/><del>{c.before[key] || "—"}</del></p><p><small>Предложено</small><br/><ins>{c.after[key] || "—"}</ins></p></div>)}
                  {!granular&&c.before.canvas&&c.after.canvas&&<p className="hint mb-3">Эта правка также меняет данные слайда или порядок слоёв, поэтому принимается целиком.</p>}
                  {c.objectDecisions&&<p className="hint mb-3">{reviewStatus(c)}</p>}

                  <div className="review-pair" data-mode={comparison} id={`review-preview-${c.id}`} tabIndex={-1}>
                    {(
                      [
                        [stale?"До предложения":"Сейчас", preview.before],
                        [stale||sourceWarning(c)?"Исходное предложение":"После принятия", preview.after],
                      ] as const
                    ).filter((_,i)=>comparison==="both"||(comparison==="before"?i===0:i===1)).map(([label, s]) => (
                      <div key={label}>
                        <span className="eyebrow">{label}</span>
                        <ReviewImage slide={s} deck={deck} index={Math.max(0,index)} objects={objects} activeId={activeId} showMarks={showMarks} onSelect={selectObject}/>
                        {s.intent && canonicalJson(c.before.intent)!==canonicalJson(c.after.intent) && (
                          <div className="review-intent">
                            <strong>{roleNames[s.intent.role]}</strong>
                            <p>{s.intent.takeaway || "Вывод не указан"}</p>
                            <p className="hint">{s.intent.transition}</p>
                            {s.intent.openQuestions.map((q, i) => (
                              <p className="narrative-warning" key={i}>
                                {q}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  {stale&&current&&<details className="mt-3"><summary>Посмотреть текущий слайд</summary><SlideCanvas slide={current} brand={deck.state.doc.brand} design={deck.state.doc.design} index={Math.max(0,index)} total={deck.state.doc.slides.length}/></details>}
                  {!!objects.length&&<section className="review-objects-section" aria-label="Правки объектов">
                    <h4>{granular?"Отдельные правки":"Что изменилось в объектах"}</h4>
                    <ObjectChanges sourceWarning={sourceWarning(c)} change={c} current={current} items={objects} activeId={activeId} onLocate={id=>{setComparison("both");setShowMarks(true);setActiveObject({changeId:c.id,id});reveal(`review-preview-${c.id}`);}} disabled={disabled||deck.role==="viewer"} onDecide={(id,decision)=>onAction("review_objects",{proposalId:p.id,changeId:c.id,elementIds:[id],decision},decision==="accepted"?"Правка объекта принята":"Правка объекта отклонена")}/>
                  </section>}
                  <details className="hint mt-3">
                    <summary>Технические подробности</summary>
                    <pre className="whitespace-pre-wrap break-all mt-2">
                      {JSON.stringify(
                        Object.fromEntries(
                          [
                            ...new Set([
                              ...Object.keys(c.before),
                              ...Object.keys(c.after),
                            ]),
                          ]
                            .filter(
                              (k) =>
                                canonicalJson(
                                  c.before[k as keyof typeof c.before],
                                ) !==
                                canonicalJson(
                                  c.after[k as keyof typeof c.after],
                                ),
                            )
                            .map((k) => [
                              k,
                              {
                                before:
                                  c.before[k as keyof typeof c.before] ?? null,
                                after:
                                  c.after[k as keyof typeof c.after] ?? null,
                              },
                            ]),
                        ),
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </div>
              );
            })}
          <div className="row mt-4 review-actions">
            <Button
              variant="outline"
              disabled={
                disabled ||
                deck.role === "viewer" ||
                !p.changes.some(
                  (c) =>
                    c.status === "pending" &&
                    selected.includes(c.id) &&
                    acceptable(c),
                )
              }
              onClick={() =>
                onAction(
                  "accept",
                  {
                    proposalId: p.id,
                    changeIds: p.changes
                      .filter(
                        (c) =>
                          c.status === "pending" &&
                          selected.includes(c.id) &&
                          acceptable(c),
                      )
                      .map((c) => c.id),
                  },
                  "Выбранные изменения приняты",
                )
              }
            >
              <Check size={16} />
              Принять выбранные слайды ({p.changes.filter(c=>c.status==="pending"&&selected.includes(c.id)).length})
            </Button>
            <Button
              variant="outline"
              disabled={disabled || deck.role === "viewer"}
              onClick={() =>
                onAction(
                  "reject",
                  { proposalId: p.id },
                  "Оставшиеся изменения отклонены",
                )
              }
            >
              Отклонить оставшиеся
            </Button>
          </div>
        </section>
      );})}
    </div>
  );
}
