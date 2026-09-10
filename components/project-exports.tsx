import {useEffect,useState,useRef} from 'react';
import type {ExportPage,ExportSummary} from '../lib/project/export-artifact';
import {download,safeName} from '../lib/export';
import {Button} from './ui/button';
export function ProjectExports({revision,api}:{revision:number;api:(path:string)=>Promise<Response>}){
 const generation=useRef(0),[reload,setReload]=useState(0);
 const [page,setPage]=useState<ExportPage>({items:[],nextCursor:null}),[error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 useEffect(()=>{let live=true;generation.current++;setLoading(true);setError('');void api('/api/export-artifacts').then(r=>r.json() as Promise<ExportPage>).then((p:ExportPage)=>{if(live)setPage(p);}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[api,revision,reload]);
 async function save(entry:ExportSummary,part:'file'|'manifest'){
  if(busy)return;setBusy(true);setError('');
  try{const r=await api(`/api/export-artifacts?artifactId=${entry.id}&part=${part}`);download(await r.blob(),`${safeName(entry.title)}-v${entry.revision}${part==='manifest'?'-manifest.json':'.'+entry.output.format}`);}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <section className="project-exports" aria-labelledby="export-history-heading">
  <div className="row"><h2 id="export-history-heading">Готовые файлы</h2><Button variant="ghost" disabled={loading||busy} onClick={()=>setReload(v=>v+1)}>Обновить</Button></div>
  <p className="hint">Сохранённые PDF и PowerPoint. Повторное скачивание возвращает тот же файл, даже после правок презентации. Это не согласование выпуска.</p>
  <details className="export-font-help"><summary>Шрифты для PowerPoint и Keynote · Focus 3</summary><p className="hint">Если текст выглядит иначе, установите IBM Plex из комплекта и заново откройте презентацию. Получателю файла тоже нужны эти шрифты. Установка не выполняется автоматически; в компании может потребоваться помощь администратора.</p><a href="/fonts/focus3-fonts.zip" download="lanka-focus3-fonts.zip">Скачать шрифты Focus 3 и лицензии</a><p className="hint">Комплект не включает другие корпоративные шрифты. Для точной композиции используйте PDF.</p></details>
  {error&&<p role="alert">{error}</p>}
  {loading?<p role="status">Загрузка…</p>:!page.items.length&&<p className="hint">Новых выгрузок пока нет. Здесь появятся файлы, созданные кнопками PDF и PowerPoint или через агента. Старые файлы без паспорта версии в этот список не входят.</p>}
  <div className="export-history-list">{page.items.map(e=><article key={e.id}>
   <div><strong>{e.output.format.toUpperCase()} · версия {e.revision}{e.revision===revision?' · текущая':''}</strong><p>{e.title}</p><small>{new Date(e.createdAt).toLocaleString('ru-RU')} · {Math.ceil(e.output.bytes/1024)} КБ</small></div>
   {e.capabilities&&<details className="export-font-help"><summary>Что сохраняется в {e.output.format.toUpperCase()}</summary>
    <p className="hint">{e.output.format==='pptx'?'Текст, фигуры, изображения, таблицы и диаграммы экспортированы отдельными объектами. Шрифты и интервалы могут отличаться в PowerPoint.':'PDF сохраняет визуальное представление. Таблицы и диаграммы не остаются объектами с редактируемыми данными.'}</p>
    <ul>{e.capabilities.slides.map((s,i)=>{const counts=new Map<string,number>();const names={text:'текст',rect:'фигуры',image:'изображения',chart:'диаграммы',table:'таблицы'};for(const o of s.objects)counts.set(names[o.kind],(counts.get(names[o.kind])??0)+1);return <li key={s.slideId}>Слайд {i+1}: {[...counts].map(([name,count])=>`${name} — ${count}`).join(', ')||'нет объектов'}</li>;})}</ul>
   </details>}
   <div className="row"><Button variant="outline" disabled={busy} onClick={()=>void save(e,'file')}>Скачать {e.output.format.toUpperCase()}</Button><Button variant="ghost" disabled={busy} onClick={()=>void save(e,'manifest')} title="Документ, версия, источники и контрольная сумма файла">Паспорт версии</Button></div>
  </article>)}</div>
  {page.nextCursor&&<Button variant="outline" disabled={busy} onClick={async()=>{const epoch=generation.current;setBusy(true);setError('');try{const next:ExportPage=await (await api(`/api/export-artifacts?cursor=${page.nextCursor}`)).json();if(epoch===generation.current)setPage(p=>({items:[...p.items,...next.items],nextCursor:next.nextCursor}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>Показать ещё</Button>}
 </section>;
}
