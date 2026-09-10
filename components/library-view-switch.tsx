import {LayoutGrid,List} from 'lucide-react';
export type LibraryView='cards'|'list';
export function LibraryViewSwitch({view,onChange}:{view:LibraryView;onChange:(view:LibraryView)=>void}){
 return <div className="library-view-switch" role="group" aria-label="Вид библиотеки">
  <button aria-pressed={view==='cards'} onClick={()=>onChange('cards')}><LayoutGrid size={16} aria-hidden="true"/>Карточки</button>
  <button aria-pressed={view==='list'} onClick={()=>onChange('list')}><List size={16} aria-hidden="true"/>Список</button>
 </div>;
}
