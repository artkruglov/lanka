export type RunPhase='CONNECT'|'READ_SESSION'|'RESUME'|'VERIFY_TOOLS'|'TURN'|'FINALIZE';

/** Keep a useful diagnostic without storing provider messages, paths, prompts or credentials. */
export function runFailure(error:unknown,phase:RunPhase){
  const e=error instanceof Error?error:new Error('Unknown failure');
  if((e as Error&{reason?:string}).reason==='THREAD_IN_USE')return {code:'NATIVE_THREAD_IN_USE',message:'Эта беседа уже открыта в другом экземпляре Codex. Освободите её там, затем повторите сообщение в Lanka. Поручение не запущено; история и презентация сохранены.'};
  if(e.message==='AUTH_REQUIRED')return {code:'AUTH_REQUIRED',message:'Нужен вход или повторное подключение Codex. Сообщение сохранено.'};
  if(e.message==='NATIVE_BUSY')return {code:'NATIVE_BUSY',message:'Запрошена остановка предыдущего вычисления. Дождитесь её завершения и повторите сообщение. История и сохранённые результаты остаются в Lanka.'};
  if(e.message==='NATIVE_PREVIEW_REQUIRED')return {code:'NATIVE_PREVIEW_REQUIRED',message:'Результат сохранён, но агент не завершил просмотр всех изменённых слайдов. Проверьте его перед принятием.'};
  const known:Record<string,string>={'Codex request timed out':'TIMEOUT','Codex turn timed out':'TIMEOUT','Codex request failed':'RPC','Codex process stopped':'PROCESS_STOPPED','Native MCP tools differ from this run\'s permissions':'TOOL_SCOPE','NATIVE_RESUME_FAILED':'THREAD_ID','Task interrupted':'INTERRUPTED'};
  const rpcCode=(e as Error&{rpcCode?:number}).rpcCode;
  const reason=known[e.message]||'FAILED';
  const code=`NATIVE_${phase}_${reason}${reason==='RPC'&&Number.isSafeInteger(rpcCode)?`_${rpcCode}`:''}`;
  const message=phase==='TURN'&&reason==='TIMEOUT'?'Агент не завершил поручение за отведённое время. Сообщение и уже сохранённые результаты остаются в Lanka. Проверьте их перед повторной отправкой.':
    phase==='CONNECT'?'Не удалось подключиться к Codex. Проверьте подключение агента и повторите поручение.':
    phase==='READ_SESSION'||phase==='RESUME'?'Не удалось открыть сохранённую беседу Codex. История в Lanka сохранена. Повторите поручение после проверки подключения.':
    phase==='VERIFY_TOOLS'?'Не удалось проверить инструменты агента для этой презентации. Поручение не запущено. Проверьте подключение и повторите.':
    'Не удалось завершить поручение. Сообщение и уже сохранённые результаты остаются в Lanka. Проверьте их перед повторной отправкой.';
  return {code,message};
}
