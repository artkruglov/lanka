export type BridgeExecutionView={id:string;state:string;leaseExpiresAt:string;lastSeenAt:string;reportedBy:string};
export function bridgeMessageStatus(delivery:string,execution:BridgeExecutionView|undefined,taskBound:boolean|undefined){
 const stopped=execution?.state==='stopped',failed=execution?.state==='failed',unknown=execution?.state==='unknown';
 if(delivery==='cancelled')return {
  label:stopped?'Агент остановлен':failed?'Исполнение завершилось с ошибкой':execution?'Отмена запрошена':'Поручение отменено',
  detail:taskBound?(stopped||failed?'Дальнейшие правки запрещены. Сохранённые предложения остаются для проверки.':unknown?'Правки запрещены. Связь потеряна; остановка агента не подтверждена.':execution?'Правки запрещены. Ожидаем подтверждения остановки агента.':'Дальнейшие правки запрещены.'): taskBound===false?'Ожидание ответа отменено; самостоятельные права старого подключения сохраняются.':'Ожидание ответа отменено.',
  tone:unknown||failed?'warning':'neutral',
 };
 if(delivery==='completed')return {label:'Ответ сохранён',detail:unknown?'Связь потеряна; завершение исполнителя не подтверждено.':failed?'Исполнитель сообщил об ошибке после сохранения ответа.':execution&&!stopped?'Ожидаем подтверждения завершения исполнителя.':'',tone:unknown||failed?'warning':'success'};
 if(unknown)return {label:'Связь с агентом потеряна',detail:'Правки приостановлены. Не повторяйте запрос до проверки предыдущего запуска.',tone:'warning'};
 if(failed)return {label:'Агент завершился с ошибкой',detail:'Ответ не сохранён. Уже созданные предложения можно проверить в документе.',tone:'warning'};
 if(stopped)return {label:'Агент остановлен',detail:'Ответ не сохранён. Уже созданные предложения остаются в документе.',tone:'neutral'};
 if(execution?.state==='running')return {label:'Агент выполняет поручение',detail:'Исполнитель подтверждает связь. Результат появится здесь после сохранения ответа.',tone:'active'};
 if(execution?.state==='claimed')return {label:'Запускаем агента',detail:'Поручение закреплено за исполнителем. Запуск модели ещё не подтверждён.',tone:'active'};
 if(delivery==='received_by_mcp_client')return {label:'Сообщение получено',detail:'MCP-клиент забрал сообщение; запуск агента пока не подтверждён.',tone:'neutral'};
 return {label:delivery==='waiting'?'Ожидает агента':'Статус уточняется',detail:delivery==='waiting'?'Для ответа нужен работающий исполнитель подключённой беседы.':'',tone:'neutral'};
}
