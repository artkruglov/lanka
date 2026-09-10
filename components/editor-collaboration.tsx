import {ColleagueReviewButton} from './colleague-review';
import {useId,useState} from 'react';
import {DocumentSharingButton} from './document-sharing';
import {DocumentPublicationsButton} from './document-publications';
import {AgentDelegationButton} from './agent-delegation';
export function EditorCollaboration({revision,disabled}:{revision:number;disabled:boolean}){
 const [open,setOpen]=useState(false),id=useId();
 return <div className="editor-collaboration" data-open={open}>
  <button type="button" className="editor-collaboration-toggle" aria-label="Совместная работа" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(!open)}>Команда</button>
  <div id={id} className="editor-collaboration-controls">
   <ColleagueReviewButton revision={revision} disabled={disabled}/><DocumentSharingButton/><DocumentPublicationsButton revision={revision} disabled={disabled}/><AgentDelegationButton compact/>
  </div>
 </div>;
}
