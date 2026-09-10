import type {ReactNode} from 'react';
import {ArrowUpRight} from 'lucide-react';

/** Presentation only: each catalog retains its own access-filtered data and destination. */
export function LibraryCatalogCard({href,cover,title,metadata,kind,action,children}:{href:string;cover:ReactNode;title:string;metadata:ReactNode;kind:'document'|'publication';action:string;children?:ReactNode}) {
 return <li className="library-catalog-card" data-kind={kind}>
  <a href={href}>{cover}<span className="shared-library-description"><span className="library-catalog-kind">{kind==='publication'?'Опубликованная версия':'Рабочий документ'}</span><strong>{title}</strong>{metadata}</span><span className="shared-library-mode">{action}<ArrowUpRight size={16} aria-hidden="true"/></span></a>
  {children}
 </li>;
}
