import {BridgeTransportError} from './corporate-mcp-client.mjs';
export class CompanionFault extends Error{constructor(code){super(code);this.code=code;}}
const messages={
 RECOVERY_UNCONFIRMED:'Восстановление не подтверждено. Проверьте прежний процесс и состояние исполнения. Оставшиеся блокировки не удаляйте вручную; модель не запускалась.',
 READ_CANCELLED:'Проверка отменена. Модель не запускалась.',
 READ_TIMEOUT:'Codex не завершил проверку за минуту. Проверьте соединение и повторите проверку. Модель не запускалась.',
 MODEL_UNAVAILABLE:'Модель не найдена в каталоге выбранного Codex. Проверьте название модели в локальной конфигурации и доступ аккаунта.',
 LOGIN_CANCELLED:'Вход отменён. Вы можете запросить новый код.',
 LOGIN_TIMEOUT:'Время ожидания входа истекло. Запросите новый код.',
 LOGIN_FAILED:'Вход не подтверждён. Повторите вход в выбранный профиль.',
 AUTH_REQUIRED:'Войдите в отдельный профиль Codex для Lanka, затем повторите проверку подключения. Модель не запускалась.',
 BINDING_REQUIRED:'Свяжите ключ с этой беседой в режиме поручений. Выдачи доступа к библиотеке недостаточно.',
 INSTANCE_LOCKED:'Состояние занято другим исполнителем или осталось после сбоя. Нажмите «Проверить и восстановить»: продолжение будет доступно только после проверки прежнего запуска.',
 CONFIGURATION:'Проверьте локальную конфигурацию, абсолютные пути и права 600 на файлы с ключом.',
 ACCESS_DENIED:'Lanka не приняла ключ доступа. Проверьте срок, отзыв и привязку к выбранной беседе.',
 NETWORK_UNCERTAIN:'Нет подтверждённого ответа Lanka. Восстановите соединение и сверьте checkpoint: отправленная операция могла сохраниться.',
 PROTOCOL:'Ответ Lanka не соответствует ожидаемому протоколу. Сохраните checkpoint и проверьте версии сервера и companion.',
 INTERRUPTED:'Остановка запрошена. Завершение агента проверяется по журналу исполнения; это сообщение само по себе его не подтверждает.',
 UNKNOWN:'Исполнение прервано. Сохраните checkpoint и проверьте состояние поручения в Lanka перед повторным запуском.',
};
export function companionDiagnostic(error,{interrupted=false}={}){
 let code=error instanceof CompanionFault?error.code:'UNKNOWN';
 if(error instanceof BridgeTransportError){code=['http_401','http_403','http_404'].includes(error.code)?'ACCESS_DENIED':['network_failure','interrupted','response_interrupted','http_503','http_502','http_504'].includes(error.code)?'NETWORK_UNCERTAIN':['invalid_configuration','invalid_endpoint'].includes(error.code)?'CONFIGURATION':'PROTOCOL';}
 else if(['EACCES','EPERM','ENOENT'].includes(error?.code))code='CONFIGURATION';
 if(interrupted&&code==='UNKNOWN')code='INTERRUPTED';
 if(!Object.hasOwn(messages,code))code='UNKNOWN';
 return {state:'needs_attention',code,message:messages[code]};
}
