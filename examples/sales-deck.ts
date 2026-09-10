import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { blankSlide, defaultBrand, type DeckDoc, type Slide } from "../lib/domain/model";
import { ProjectClient } from "../scripts/project-mcp/client.mjs";

const productFacts=[
  "Lanka Studio — product evidence, 2026-09-05, v0.8 implementation.",
  "Current code: semantic DeckDoc with brief and slide intent, tables, chart data and image references. Shared versioned scene renders browser, PDF and editable shapes/text in PPTX.",
  "Task briefing: three required questions, explicit assumptions, human confirmation before agent claim; human review of story before composition.",
  "Folder workflow: one configured project root, project.json, hashed materials, browser inspector, comments and proposals. MCP has feedback long polling, compact semantic edits and linked replies. ProjectReviewSession reuses one Codex thread while the worker runs. Separately configured credentials required. It does not attach to an arbitrary browser chat. No successful live authenticated model demo is claimed.",
  "Human acceptance applies proposals; stale changes cannot overwrite newer edits. Partial acceptance is per slide. UI polls saved document and comments; no character-level CRDT or streaming slide generation.",
  "Hosted code has individual deck permissions, tasks and immutable releases. Cloud and local folders are separate modes; no corporate drive sync. The Sites publication is owner-private, not a multi-organization production service.",
  "Folio and Boardroom are composition families. Complete enterprise Brand Pack onboarding, SSO/SCIM, tenant provisioning, inherited folder ACL and visual golden certification remain work.",
  "Charts and tables export as editable text/shapes, not native PowerPoint chart/table objects. No full PPTX round-trip fidelity.",
  "No customer ROI, price, customer count or case study is established. No objective superiority over Google Slides is claimed."
].join("\n");
const pilotFacts=[
  "Proposed pilot scope; not a customer commitment or measured result.",
  "One team, one recurring scenario, two review cycles.",
  "A prior deck and brand reference are useful but not required for the initial briefing.",
  "Measure time to accepted draft against existing process; business reviewer assesses logic; brand representative assesses design; expert checks source figures.",
  "Agree success thresholds, deployment boundary, pilot owner and kickoff before starting. No date, price or percentage benefit is promised."
].join("\n");
const source=(name:string,text:string)=>({name,contentType:"text/markdown" as const,base64:Buffer.from(text).toString("base64"),id:"src-"+createHash("sha256").update(text).digest("hex")});
const facts=source("Lanka product facts v0.8.md",productFacts),pilot=source("Proposed pilot.md",pilotFacts);
function slide(layout:Slide["layout"],title:string,eyebrow:string,body:string,role:NonNullable<Slide["intent"]>["role"],transition:string,notes:string,sourceId=facts.id):Slide {
  return {...blankSlide(layout),title,eyebrow,body,sourceIds:[sourceId],notes:notes+"\n\n[Sources]\n"+(sourceId===facts.id?facts.name:pilot.name)+"\n[/Sources]",intent:{role,takeaway:title.replace(/\n/g," "),transition,openQuestions:[]}};
}
const doc:DeckDoc={
  schemaVersion:1,id:randomUUID(),title:"Lanka — презентации, над которыми работает команда",design:"folio-v1",
  brand:{...defaultBrand,name:"Lanka / Graphite",primary:"#354BDA",ink:"#18201E",paper:"#F7F8F2",accent:"#D4F572"},
  brief:{audience:"Бизнес-заказчик крупной организации: руководитель команды, регулярно готовящей презентации.",decision:"Выбрать сценарий и ответственного для пилота Lanka.",keyMessage:"Lanka соединяет подготовку агентом с понятной человеку проверкой, правками и общим проектом."},
  slides:[
    slide("cover","Презентации,\nнад которыми\nработает команда","LANKA / ПРЕДЛОЖЕНИЕ ПИЛОТА","Агент собирает историю.\nЛюди доводят её до решения.","context","Где сегодня теряется работа команды?","Аудитория и цель — рабочие гипотезы. Не обещать готовое enterprise-внедрение."),
    slide("split","Хорошая презентация начинается\nраньше первого слайда","ЗАДАЧА КОМАНДЫ","Понять, что сказать\nАудитория, решение, аргументы и материалы.\n\nДоговориться о результате\nЗамечания, правки и версия, которую можно показать.","problem","Как соединить подготовку и согласование?","Рамка процесса, не статистическое утверждение. Попросить заказчика показать текущий процесс."),
    slide("statement","Агент готовит.\nКоманда управляет.","ПОДХОД LANKA","Содержание, замечания и предложенные изменения остаются в одном проекте.","recommendation","Как выглядит весь путь пользователя?","У агента нет инструментов утверждения и публикации. Изоляция всего окружения — отдельная задача внедрения."),
    slide("steps","Начать можно\nс короткого запроса","КАК ЭТО РАБОТАЕТ","Уточнить\nДля кого и ради какого решения.\n\nВыстроить\nВыводы и аргументы по слайдам.\n\nСобрать\nКомпозицию, текст и материалы.\n\nПроверить\nПринять результат или доработать.","context","Что происходит, если результат нужно изменить?","Брифинг и план подтверждает человек. Для генерации нужны отдельно настроенные учётные данные."),
    slide("content","Замечание\nпревращается\nв правку","СОВМЕСТНАЯ РАБОТА","Вы отмечаете слайд\nПишете, что изменить и почему.\n\nАгент отвечает\nПредлагает формулировку или уточняет вопрос.\n\nВы принимаете\nВидите результат до изменения общей версии.","evidence","На чём основано такое редактирование?","Локальная папка, MCP и работающий review worker. Один поток Codex в течение работы worker. Предложение появляется после шага; посимвольной трансляции слайдов нет. Интеграционный тест использует подставной ответ модели."),
    slide("split","Смысл сохраняется.\nОформление можно менять.","СЦЕНАРИЙ И ДИЗАЙН","Что нужно донести\nВывод, аргументы и следующий шаг каждого слайда.\n\nКак это показать\nТипографика, сравнение, таблица, график или изображение.","evidence","Как организовать документы клиента?","DeckDoc — каноническая модель. Folio и Boardroom — разные правила композиции. Полный сертифицированный Brand Pack ещё не реализован."),
    slide("content","Работайте\nс выбранным\nпроектом","МАТЕРИАЛЫ И КОНТЕКСТ","Соберите основания\nБриф, документы и изображения рядом с презентацией.\n\nПодключите агента\nПроектный MCP открывает одну заданную папку.\n\nСохраните результат\nПравки остаются в проекте; PDF и PPTX — на выходе.","evidence","Что готово к проверке и что нужно для внедрения?","MCP ограничивает свои инструменты; это не OS-песочница. Нет автосинхронизации с корпоративным диском. Облачный режим имеет отдельное хранилище."),
    {...slide("table","Проверим продукт\nдо масштабирования","ГОТОВНОСТЬ К ПИЛОТУ","Контур доступа и условия работы с данными согласуем перед пилотом.","options","По каким критериям оценивать пилот?","Честное разделение работающего кода и требований enterprise-внедрения."),table:{columns:["Сценарий","Проверяем сейчас","Для внедрения"],rows:[["Подготовка","Бриф → план → слайды","Агент клиента"],["Правки","Редактор и предложения","Контур команды"],["Дизайн","Folio и Boardroom","Сертификация бренда"],["Хранение","Папка / облако","Корпоративный диск, SSO"]],sourceId:facts.id}},
    {...slide("table","Ценность измерим\nна вашей презентации","КРИТЕРИИ ПИЛОТА","Порог успеха фиксируем вместе до начала работы.","decision","Какой объём нужен для первой проверки?","Показатели эффективности пока не измерены. Это предложенная методика.",pilot.id),table:{columns:["Что оцениваем","Как проверяем","Кто оценивает"],rows:[["Время","До принятого черновика","Владелец сценария"],["Аргументация","Ясность вывода и логика","Бизнес-заказчик"],["Визуальное качество","Соответствие референсу","Представитель бренда"],["Точность","Цифры и их источники","Эксперт по данным"]],sourceId:pilot.id}},
    {...slide("metrics","Небольшой пилот.\nКонкретный результат.","ПРЕДЛАГАЕМЫЙ ОБЪЁМ","Сценарий, ответственного и критерии согласуем вместе.","recommendation","Что нужно от заказчика, чтобы начать?","Предложение объёма, не измеренные результаты и не согласованные условия.",pilot.id),metrics:[{id:"pilot-team",value:1,unit:"команда",label:"Участники пилота",sourceId:pilot.id},{id:"pilot-story",value:1,unit:"сценарий",label:"Повторяющаяся задача",sourceId:pilot.id},{id:"pilot-reviews",value:2,unit:"цикла проверки",label:"Создать и доработать",sourceId:pilot.id}]},
    slide("closing","Давайте начнём\nс вашей задачи","СЛЕДУЮЩИЙ ШАГ","Выберите презентацию и владельца пилота.\nМы поможем собрать бриф и первый вариант.","next_step","","Выбрать задачу, ответственного и визуальный ориентир. Предыдущая дека и брендбук полезны, но не обязательны для первого брифинга. Даты и коммерческие условия не обещаны.",pilot.id),
  ]
};
const root=resolve(process.argv[2]);await mkdir(root,{recursive:true});
const client=new ProjectClient(root),events:unknown[]=[];
try {
  const init=await client.call("initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"codex-lanka-sales",version:"0.8.0"}});events.push({method:"initialize",result:init.result});
  events.push({tool:"get_briefing_questions",result:await client.tool("get_briefing_questions")});
  await client.tool("get_authoring_guide");events.push({tool:"get_authoring_guide",result:"Read the design and semantic authoring contract"});
  const briefing=Object.fromEntries(Object.entries(doc.brief!).map(([key,value])=>[key,{value,origin:"assumption"}]));
  const made=await client.tool("create_deck",{requestId:randomUUID(),doc,briefing,sources:[facts,pilot].map(({id,...s})=>s)});events.push({tool:"create_deck",result:made});
  const check=await client.tool("lint_deck",{deckId:made.deckId});events.push({tool:"lint_deck",result:check});
  if(check.overflowSlides.length || check.issues.some((v:any)=>v.severity==="error"))throw new Error(JSON.stringify(check));
  for(const format of ["pptx","pdf"])events.push({tool:"export_deck",result:await client.tool("export_deck",{deckId:made.deckId,expectedRevision:1,format})});
  await writeFile(resolve(root,"mcp-run.json"),JSON.stringify({execution:"Actual stdio MCP calls by this assistant. Briefing asked in chat; no answers returned, defaults remain assumptions. No separate authenticated model invocation.",events},null,2));
  await writeFile(resolve(root,"deck.json"),JSON.stringify(doc,null,2));
  process.stdout.write(JSON.stringify({root,deckId:made.deckId,slides:doc.slides.length,check})+"\n");
} finally {client.close();}
