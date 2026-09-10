# Внешнее размещение Lanka Studio

Актуализация направления, 6 сентября 2026: основной целевой выпуск — открытая самостоятельная установка в контуре компании, см. [OPEN_WORKSPACE_STRATEGY.md](../docs/OPEN_WORKSPACE_STRATEGY.md). Ниже сохранена ранее подготовленная конфигурация конкретных внешних провайдеров. Она остаётся возможным адаптером размещения и не является обязательной инфраструктурой продукта. Полный внутренний пакет приложения/базы/хранилища/исполнителей ещё предстоит реализовать и проверить.

Подготовлено в 0.5. **Внешние ресурсы не созданы, данные не перенесены, Codex worker не запущен в облаке.** Этот каталог даёт проверяемую конфигурацию и отдельный auth entry point. Приватный Site продолжает работать через прежний hosting dispatcher.

## Выбранный первый шаг

Для доступного стека Cloudflare + Fly.io начать с Cloudflare Worker (приложение), D1 (текущая база), R2 (материалы) и отдельной Fly Machine (Codex worker). Это соответствует существующему коду. На Fly worker — фоновый процесс без входящего HTTP-порта; он получает задания из сохранённой очереди и вызывает MCP. Выполнение Codex внутри короткого запроса Cloudflare Worker не используется.

Neon полезен как целевая PostgreSQL-база при развитии workspace/чатов, но текущий репозиторий использует D1/SQLite, транзакционные batches и свою схему. Подстановка DATABASE_URL не мигрирует приложение. Не подключать Neon фиктивно ради присутствия ещё одного облака. Перенос базы описан ниже.

Документация провайдеров: [Fly process groups](https://fly.io/docs/launch/processes/), [Fly configuration](https://fly.io/docs/reference/configuration/), [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Neon connection pooling](https://neon.com/docs/connect/connection-pooling/).

## 1. Подготовить реальное окружение

Нужны доступ к исходному проекту Higgsfield / shop reels.app и аккаунтам либо оператор с настроенными CLI. Старый статический HTML-прототип Higgsfield не содержит рабочей cloud-конфигурации. Не копировать ресурсы другого приложения по предположению.

Создать отдельные ресурсы пилота: hostname, Worker, D1 и R2, Cloudflare Access application, Fly app. Сначала использовать новый staging hostname/базу, не изменяя работающий shop reels.app. Задать политики хранения, регион и допустимый inference provider в соответствии с выбранным окружением.

Установить зависимости корня и runtime из lockfiles. Скопировать пустой пример и заполнить **настоящие не секретные** идентификаторы:

```sh
cp deploy/external.example.json deploy/external.json
node deploy/configure.mjs deploy/external.json
```

`deploy/external.json` и `.external/` исключены из git. Генератор проверяет поля и создаёт `.external/wrangler.json` и `.external/fly.toml`; он не обращается к аккаунтам и ничего не размещает. workerEmail — отдельный email служебного участника, не email владельца. teamDomain имеет вид `https://YOUR_TEAM.cloudflareaccess.com`, audience берётся из Access application.

## 2. Аутентификация и доступ

Cloudflare Access должен защищать весь hostname, включая assets. Люди проходят принятую организацией политику входа. Для `/api/mcp` настроить service-auth policy для service token фонового исполнителя. Защита MCP не должна превращаться в публичный bypass приложения.

Внешний entry point:

- Удаляет входящие `oai-authenticated-user-*` headers.
- Для человека проверяет RS256-подпись Access JWT, issuer, audience, expiry и обязательные claims; только затем формирует доверенную identity `cf:<sub>`.
- Для worker принимает отдельный длинный `LANKA_WORKER_TOKEN` только на `POST /api/mcp`; служебная identity — `agent:<workerId>`. Доступны 11 task tools и discovery; browser API, assets endpoint, создание/прямое изменение, sharing, approve/publish закрыты.
- Проверяет права документа внутри существующего Tool Service при каждом вызове. Токен сам права на презентации не добавляет.
- Не открывает workers.dev/preview URL; статические файлы проходят auth entry point (`run_worker_first`). Не размещать `dist/server/index.js` напрямую с доверенными заголовками из интернета.

Текущая схема — один явно настроенный служебный участник и секрет. Это ещё не multitenant OAuth, многопользовательская делегация или самостоятельная выдача scoped credentials внешним IDE. Ротацию секрета выполняет оператор через secret manager.

## 3. Собрать и разместить приложение

Из корня репозитория, после заполнения конфигурации и входа оператора в нужный Cloudflare account:

```sh
npm ci
npm run build
npx wrangler deploy --dry-run --config .external/wrangler.json --outdir .external/bundle
npx wrangler d1 migrations apply DB --remote --config .external/wrangler.json
npx wrangler secret put LANKA_WORKER_TOKEN --config .external/wrangler.json
npx wrangler deploy --config .external/wrangler.json
```

Первые две команды локальные; migrations/secret/deploy меняют указанное облако. Перед ними проверить account_id, database_id и hostname в сгенерированном файле. Использовать отдельную пустую базу пилота; импорт пользовательских данных требует процедуры миграции ниже. Секрет вводится через prompt/secret manager, не сохраняется в JSON, командах истории или переписке.

Необязательный старый one-shot Chat Completions adapter имеет отдельные LLM_API_URL/LLM_MODEL/LLM_API_KEY. Они не подключают фоновый Codex worker. Для основного сценария нужны следующие настройки Fly.

## 4. Разместить Codex worker на Fly.io

В Fly app безопасно внести:

| Переменная                                                | Значение                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| LANKA_ACCESS_TOKEN                                        | Тот же секрет, который в Worker задан как LANKA_WORKER_TOKEN                       |
| LANKA_CF_ACCESS_CLIENT_ID / LANKA_CF_ACCESS_CLIENT_SECRET | Service token для Access policy на MCP; оба значения обязательны для этой политики |
| OPENAI_API_KEY                                            | Одобренный ключ аккаунта inference, доступный этому worker                         |
| LANKA_CODEX_MODEL                                         | Доступная аккаунту модель                                                          |

`LANKA_MCP_URL` и `LANKA_PYTHON` уже задаются в сгенерированном fly.toml. Worker не передаёт Lanka/Cloudflare credential в дочерний Codex; он сам выполняет ограниченные task tools. Не использовать browser cookie или служебный токен текущего private Site.

Из директории `runtime/` с установленным и аутентифицированным flyctl:

```sh
fly deploy --config ../.external/fly.toml
```

Контекст сборки должен быть `runtime/`; Dockerfile находится в нём. Конфигурация содержит process group worker, без http_service. После deploy проверить фактическое число Machines и оставить одну для первого пилота. Настроить метрики, журнал без содержимого секретов, уведомления о завершении процесса и политику обновления образа. Docker image и live Fly configuration в этом окружении не были проверены запуском.

Служебному worker нужно выдать editor-доступ к конкретной презентации: открыть задачу → «Открыть презентацию и доступ» → «Поделиться» → добавить настроенный workerEmail. Для пилота это явное действие владельца. Общая автоматическая делегация новых задач внутри Workspace ещё не реализована; без grant worker закономерно не увидит задачу.

Сервисный Access token и собственный Lanka token нужны для двух разных проверок: пропуск через защищённый hostname и ограниченная личность внутри приложения. Один не заменяет другой.

## 5. Живая приёмка до объявления готовности

1. Без входа документ и его файл недоступны. Поддельные identity headers не помогают. Worker credential не может вызвать browser API/approve/publish.
2. Владелец открывает коллеге приложение и выдаёт viewer/editor право на deck. Коллега видит его в «Открыли мне доступ»; посторонний — нет. Отзыв блокирует последующее чтение/запись, включая worker.
3. Задача из брифа и трёх файлов проходит вопросы, принятие плана, candidate и человеческое принятие. Записать model/runtime версии, события и реальные результаты. Установка Codex сама по себе этот пункт не закрывает.
4. Закрытие вкладки не теряет job; cancel, потеря lease, повтор команды и ручная правка во время исполнения не создают позднего overwrite.
5. Прямое редактирование текста сохраняется, повторный вход видит результат; конфликт двух редакторов показывается и позволяет сохранить локальную копию.
6. Проверить экспорт и бэкап/восстановление на staging; внешний URL объявлять рабочим только после этих действий.

## 6. Перенос данных и Neon

Первый внешний staging может быть пустым. Клонирование доступной презентации через JSON не является переносом всех ACL/истории/комментариев. Источники между независимыми инстансами нужно переносить вместе с записями и объектами.

Полная миграция: реестр документов/ревизий/выпусков/источников/задач → резервные копии D1 и R2 → сверка ownership → остановка записей на время cutover → перенос с сохранением ID/hashes → проверки количества и прав → переключение hostname → read-only исходный инстанс на период проверки. Выполнять по реальным ресурсам, не по примерам.

Identity из Sites и `cf:<sub>` отличаются. Нельзя считать перенос email достаточным доказательством принадлежности владельца: нужна проверенная таблица соответствия и явная миграция ownership/actors, иначе старые документы станут недоступны или права будут назначены неверно.

Для Neon сначала добавить PostgreSQL storage adapter и миграции, затем перенести все сущности и проверить эквивалентность транзакций: CAS, command receipts, конкурентные task claims, отмена и отзыв доступа. Использовать один авторитетный store на cutover; не вводить непроверенную двойную запись D1+Neon. Подключения фоновых workers могут использовать pooled URL; выбор драйвера/Hyperdrive/serverless transport для Cloudflare проверяется отдельным integration spike. После миграции — отдельные backup/restore и нагрузочные проверки. Параметр DATABASE_URL в текущем приложении эту работу не выполняет.
