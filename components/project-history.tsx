import {historySlideComparisons,historySourceComparisons} from '../lib/project/history-comparison';
import {EditorBackups} from './editor-backups';
import { useEffect, useRef, useState } from "react";
import type { DeckDoc,Source } from "../lib/domain/model";
import { SlideCanvas } from "./slide-canvas";
import { Button } from "./ui/button";
import {ProjectExports} from './project-exports';
export function ProjectHistory({
  doc,
  sources,
  exportEpoch=0,
  onImportBackup,
  revision,
  disabled,
  api,
  onRestore,
}: {
  doc: DeckDoc;
  sources:Source[];
  exportEpoch?:number;
  onImportBackup?:(raw:string)=>void;
  revision: number;
  disabled: boolean;
  api: (path: string, body?: undefined, options?: {signal?: AbortSignal}) => Promise<Response>;
  onRestore: (revision: number) => void;
}) {
  const [entries, setEntries] = useState<
      { revision: number; createdAt: string; action: string }[]
    >([]),
    [selected, setSelected] = useState<DeckDoc | null>(null),
    [version, setVersion] = useState(0),
    [error, setError] = useState("");
  const [sourceSnapshot,setSourceSnapshot]=useState<{sources:Source[];unavailable:{sha256:string}[]}|null>(null);
  const sourceChanges=sourceSnapshot?historySourceComparisons(sourceSnapshot.sources,sources).filter(s=>s.status!=='unchanged'):[];
  const [imageError,setImageError]=useState(false);
  const selectionRequest = useRef(0);
  const selectedController = useRef<AbortController | null>(null);
  const [listError, setListError] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [retryList, setRetryList] = useState(0);
  const [loadingVersion, setLoadingVersion] = useState(false);
  useEffect(() => {
    selectionRequest.current++;
    setSelected(null); setSourceSnapshot(null); setImageError(false); setVersion(0); setLoadingVersion(false); setError("");
    return () => { selectionRequest.current++; selectedController.current?.abort(); };
  }, [doc.id, api]);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      if (live) { setListError("История не загрузилась за 20 секунд. Проверьте подключение и повторите."); setLoadingList(false); }
    }, 20_000);
    setLoadingList(true); setListError(""); setEntries([]);
    void api("/api/history", undefined, {signal: controller.signal})
      .then((r) => r.json())
      .then((v) => {
        if (live && !controller.signal.aborted) setEntries((v as typeof entries).slice().reverse());
      })
      .catch((e) => {
        if (live) setListError(controller.signal.aborted
          ? "История не загрузилась за 20 секунд. Проверьте подключение и повторите."
          : e.message);
      })
      .finally(() => { clearTimeout(timer); if (live) setLoadingList(false); });
    return () => { live = false; clearTimeout(timer); controller.abort(); };
  }, [doc.id, revision, api, retryList]);
  const refreshUi=typeof document!=="undefined"&&document.body.dataset.ui==="refresh";
  const auxiliary=<div className="history-files"><EditorBackups key={doc.id} documentId={doc.id} onImport={onImportBackup}/><ProjectExports key={`${doc.id}:${exportEpoch}`} revision={revision} api={api}/></div>;
  return (
    <div className="local-history">
      {!refreshUi&&auxiliary}
      <h2>История версий</h2>
      <p className="hint">
        Сохранения и принятые предложения. Восстановление создаёт новую версию.
      </p>
      {loadingList && <p role="status">Загружаем историю…</p>}
      {listError && <div role="alert"><p>{listError}</p><Button onClick={() => setRetryList(n => n + 1)}>Повторить загрузку истории</Button></div>}
      {!loadingList && !listError && entries.length === 0 && <p className="hint">Сохранённых версий пока нет.</p>}
      {error && <p role="alert">{error} Нажмите на версию, чтобы попробовать снова.</p>}
      <div className="history-versions" role="group" aria-label="Сохранённые версии">
        {entries.map((e) => (
          <button
            key={e.revision}
            aria-pressed={version === e.revision}
            onClick={async () => {
              const request = ++selectionRequest.current;
              selectedController.current?.abort();
              const controller = new AbortController();
              selectedController.current = controller;
              const timer = setTimeout(() => {
                controller.abort();
                if (request === selectionRequest.current) {
                  selectionRequest.current++;
                  setError("Версия не загрузилась за 20 секунд. Проверьте подключение.");
                  setLoadingVersion(false);
                }
              }, 20_000);
              setVersion(e.revision); setSelected(null); setSourceSnapshot(null); setImageError(false); setLoadingVersion(true); setError("");
              try {
                const result = await (
                  await api(`/api/history?revision=${e.revision}&include=sources`, undefined, {signal: controller.signal})
                ).json() as DeckDoc|{doc:DeckDoc;sourceSnapshot:typeof sourceSnapshot};
                if (request === selectionRequest.current && !controller.signal.aborted){setSelected('doc' in result?result.doc:result);setSourceSnapshot('doc' in result?result.sourceSnapshot:null);}
              } catch (e) {
                if (request === selectionRequest.current) setError(controller.signal.aborted
                  ? "Версия не загрузилась за 20 секунд. Проверьте подключение."
                  : (e as Error).message);
              } finally {
                clearTimeout(timer);
                if (request === selectionRequest.current) setLoadingVersion(false);
              }
            }}
          >
            <strong>
              Версия {e.revision}
              {e.revision === revision ? " · текущая" : ""}
            </strong>
            <span>{e.action}</span>
            <small><time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString("ru-RU",{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})}</time></small>
          </button>
        ))}
      </div>
      {loadingVersion && <p role="status">Загружаем версию {version}…</p>}
      {selected && (
        <>
          <div className="row">
            <h3>
              Версия {version}: {selected.title}
            </h3>
            <Button
              disabled={disabled || version === revision}
              onClick={() => onRestore(version)}
            >
              Восстановить эту версию
            </Button>
          </div>
          <p className="hint">При восстановлении вернётся весь состав и порядок выбранной версии, включая оформление.</p>
          {imageError&&<p role="alert">Не все изображения выбранной версии загрузились. Предпросмотр неполный.</p>}
          <section aria-label="Изменения источников">
            <h4>Источники</h4>
            {!sourceSnapshot?<p>Источники этой версии не сохранены в архиве. Сравнение недоступно.</p>:<>
              {sourceSnapshot.unavailable.length>0&&<p role="alert">Архив неполный: файлов недоступно — {sourceSnapshot.unavailable.length}. Восстановление может быть недоступно.</p>}
              {sourceChanges.length===0?<p>Источники не изменились.</p>:<><p>Изменения от выбранной версии к текущей. Восстановление вернёт прежний набор источников.</p><ul>{sourceChanges.map(s=><li key={s.id}>
                <strong>{s.nameChanged?`${s.before!.name} → ${s.current!.name}`:(s.current??s.before)!.name}</strong>{' — '}
                {s.status==='added'?'Добавлен':s.status==='removed'?'Удалён':s.contentChanged?'Файл заменён':s.nameChanged?'Имя изменено':'Метаданные изменены'}
              </li>)}</ul></>}
            </>}
          </section>
          {historySlideComparisons(selected, doc,{before:sourceSnapshot?.sources??null,current:sources}).map(({id, before:s, current, beforeIndex:i, currentIndex, status,changedSourceIds,sourcesUnknown}) => {
            return (
              <div key={id} className="history-slide">
                <h4>
                  {status === 'added' ? `Новый слайд ${currentIndex + 1} · будет удалён при восстановлении`
                    : status === 'removed' ? `Слайд ${i + 1} удалён · будет возвращён при восстановлении`
                    : `Слайд ${i + 1}${i !== currentIndex ? ` → ${currentIndex + 1}` : ''} · ${status === 'changed' ? 'Отличается от текущей' : sourcesUnknown?'Структура без изменений · источники не сравнены':'Без изменений'}`}
                </h4>
                {!!changedSourceIds?.length&&<p>На слайде изменились источники: {changedSourceIds.length}.</p>}
                <div className="review-pair">
                  <div>
                    <p>Версия {version}</p>
                    {s ? <SlideCanvas
                      slide={s}
                      onImageError={()=>setImageError(true)}
                      assetBaseUrl={`/api/assets?revision=${version}`}
                      brand={selected.brand}
                      design={selected.design}
                      index={i}
                      total={selected.slides.length}
                    /> : <p>В этой версии слайда ещё нет</p>}
                  </div>
                  <div>
                    <p>Сейчас · версия {revision}</p>
                    {current ? (
                      <SlideCanvas
                        slide={current}
                        brand={doc.brand}
                        design={doc.design}
                        index={currentIndex}
                        total={doc.slides.length}
                      />
                    ) : (
                      <p>Слайд удалён</p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </>
      )}
      {refreshUi&&auxiliary}
    </div>
  );
}
