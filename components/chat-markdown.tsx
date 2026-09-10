import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {ComponentProps,PropsWithChildren} from 'react';

/** Shared rendering rules for native and workspace agent replies. */
export const chatMarkdownOptions={
  remarkPlugins:[remarkGfm],
  remarkRehypeOptions:{footnoteLabel:'Примечания',footnoteBackLabel:'Вернуться к ссылке'},
  components:{
    table:({children}:PropsWithChildren)=><div className="chat-table-scroll" role="region" aria-label="Таблица из ответа агента" tabIndex={0}><table>{children}</table></div>,
    img:()=>null,
    a:({href,children}:ComponentProps<'a'>)=><a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  },
};
export function ChatMarkdown({text}:{text:string}){
  return <div className="chat-markdown"><ReactMarkdown {...chatMarkdownOptions}>{text}</ReactMarkdown></div>;
}
