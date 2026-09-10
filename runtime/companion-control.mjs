import {reclaimCompanion} from './companion-reclaim.mjs';
import {listCompanionModels} from './companion-models.mjs';
import {loginCompanion} from './companion-login.mjs';
import {runCompanion,checkCompanionConnection} from './companion-daemon.mjs';
import {CompanionFault,companionDiagnostic} from './companion-faults.mjs';
export class CompanionBusy extends Error{}
/** One locally selected configuration. No remote command/profile changes. */
export function createCompanionControl(config,{run=runCompanion,check=checkCompanionConnection,login=loginCompanion,listModels=listCompanionModels,recover=reclaimCompanion}={}){
 let models=null,operation=null,state={state:'idle',message:'Подключение ещё не проверено.'},revision=0;
 let context={server:config.url?new URL(config.url).origin:'',sessionId:config.sessionId??'',model:config.model??'',title:null,verifiedAt:null};
 const publish=next=>{state=next;revision++;};
 const snapshot=()=>({...structuredClone(state),context:structuredClone(context),models:structuredClone(models),revision,active:operation!==null,operation:operation?.kind??null});
 function begin(kind,work){
  if(operation)throw new CompanionBusy('Operation already active');
  if(kind==='models')models=null;
  if(kind==='check')context={...context,title:null,verifiedAt:null};
  const current={kind,abort:new AbortController(),done:null};operation=current;
  publish({state:kind==='recover'?'recovering':kind==='models'?'loading_models':kind==='login'?'logging_in':kind==='check'?'checking':'starting',message:kind==='recover'?'Проверяем прежнее исполнение перед восстановлением…':kind==='models'?'Читаем каталог моделей Codex…':kind==='login'?'Запрашиваем вход в выбранный профиль…':kind==='check'?'Проверяем подключение и вход…':'Запускаем локального исполнителя…'});
  current.done=Promise.resolve().then(()=>work(current)).then(()=>{
   if(current.abort.signal.aborted&&['check','models'].includes(kind)){publish({state:'cancelled',message:'Проверка отменена. Можно повторить её. Модель не запускалась.'});return;}
   publish(kind==='recover'?{state:'recovered',message:'Подтверждённые блокировки сняты. Проверьте подключение перед запуском. Модель не запускалась.'}:kind==='models'?{state:'models_ready',message:'Выберите модель следующего запуска. Файл конфигурации не изменяется.'}:kind==='login'?{state:'authenticated',message:'Вход подтверждён. Теперь проверьте подключение к Lanka.'}:kind==='check'?{state:'ready',message:'Подключение, вход и наличие модели в каталоге проверены. Модель не запускалась.'}:{state:'stopped',message:'Локальный исполнитель завершил работу.'});
  },error=>publish(current.abort.signal.aborted&&['check','models'].includes(kind)?{state:'cancelled',message:'Проверка отменена. Можно повторить её. Модель не запускалась.'}:companionDiagnostic(error,{interrupted:current.abort.signal.aborted}))).finally(()=>{if(operation===current)operation=null;});
  return snapshot();
 }
 return {
  snapshot,
  recover:()=>begin('recover',async current=>{try{const result=await recover(config,{signal:current.abort.signal});if(result?.state!=='locks_released'||result.modelStarted!==false)throw Error('Recovery not confirmed');}catch{throw new CompanionFault('RECOVERY_UNCONFIRMED');}}),
  models:()=>begin('models',async current=>{const catalog=await listModels(config,{signal:current.abort.signal});if(current.abort.signal.aborted)throw Error('Cancelled');models=catalog;}),
  login:()=>begin('login',current=>login(config,{signal:current.abort.signal,onCode:value=>{if(!current.abort.signal.aborted)publish({state:'awaiting_login',message:'Откройте страницу входа и введите код.',login:{url:value.url,code:value.code}});}})),
  check:({model}={})=>begin('check',current=>{context={...context,model:model??config.model};return check({...config,model:model??config.model},{signal:current.abort.signal,onContext:value=>{if(current.abort.signal.aborted||value?.sessionId!==config.sessionId||typeof value.title!=='string'||!value.title.trim())return;context={...context,title:value.title.slice(0,200),verifiedAt:new Date().toISOString()};revision++;}});}),
  start:({model}={})=>begin('run',current=>{context={...context,model:model??config.model};return run({...config,model:model??config.model},{signal:current.abort.signal,onStatus:event=>{
   if(current.abort.signal.aborted)return;
   const messages={connected:'Исполнитель подключён и ожидает сообщения.',working:'Агент обрабатывает поручение.',answered:'Ответ сохранён. Ожидаем следующее сообщение.',session_recovered:'Сессия восстановлена из журнала.',reconciled:'Сохранённый результат подтверждён.',ready_to_claim:'Поручение готово к повторной проверке допуска.'};
   if(Object.hasOwn(messages,event?.state))publish({state:event.state,message:messages[event.state]});
  }});}),
  stop(){if(operation){publish({state:'stopping',message:operation.kind==='recover'?'Отмена восстановления запрошена. Дождитесь результата проверки.':operation.kind==='login'?'Отменяем вход…':['check','models'].includes(operation.kind)?'Отменяем проверку…':'Останавливаем исполнителя. Дождитесь подтверждения.'});operation.abort.abort();}return snapshot();},
  async settled(){await operation?.done;return snapshot();},
 };
}
