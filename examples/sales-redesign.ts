import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import original from "./fixtures/lanka-sales-v08.json";
import { defaultBrand, validateDoc } from "../lib/domain/model";
import { ProjectClient } from "../scripts/project-mcp/client.mjs";
import { ProjectStore } from "../scripts/project-mcp/store";
import { humanCommand } from "../scripts/project-mcp/human";

const root=resolve(process.argv[2]);await mkdir(root,{recursive:true});
const facts=[
  "Lanka v0.9 implementation, 2026-09-05. Product scenario, not independent efficacy evidence.",
  "Canonical DeckDoc separates brief and slide intent from design recipes. Focus v1 has pinned tokens, recipes and fixture checks. It is a design candidate, not an enterprise-certified BrandPack.",
  "Mandatory brief → reviewed story → composition. A separately authorized agent runtime is required. Live authenticated model generation has not been verified in this environment.",
  "Comments and linked proposals; human accepts changes, with stale-version guards. No character-level CRDT. An active review worker reuses one Codex thread while its process lives.",
  "Cloud create/read MCP returns editor and presentation links for persisted documents. Opening a link does not grant permissions. Local projects export a handoff with hashed material bytes; the human imports it to create a private cloud copy, not live synchronization.",
  "Lanka sales example opens an owner-specific saved copy; repeated opening keeps that owner's edits. Other owners get separate copies. Share the canonical document link to collaborate on the same deck.",
  "SSO, inherited organization/folder permissions, full BrandPack certification, continuous agent session recovery and data publication lineage are not complete.",
  "Pilot proposal: one team, one recurring presentation, two review cycles. No customer, price, ROI, measured time saving or deployment date is promised.",
  "The before/after headline on slide 5 is an illustrative review example, not a customer quote."
].join("\n");
const hash=createHash("sha256").update(facts).digest("hex"),sourceId="src-"+hash;
const material={id:sourceId,name:"Lanka v0.9 product and pilot.md",contentType:"text/markdown",base64:Buffer.from(facts).toString("base64")};
const before=validateDoc({...original,id:randomUUID(),title:"Lanka — презентации с участием агента",design:"focus-v1",brand:{...defaultBrand},slides:original.slides.map(s=>({...s,sourceIds:[sourceId],table:s.table?{...s.table,sourceId}:undefined,metrics:s.metrics.map(m=>({...m,sourceId}))}))});
const after=structuredClone(before);
const copy=[
  ["cover","Презентации\nс участием агента.\nПод контролем команды.","ПРЕДЛОЖЕНИЕ ПИЛОТА","Соберите историю, обсудите изменения\nи сохраните результат в общем проекте."],
  ["split","Подготовка и проверка —\nв одном проекте","ЗАДАЧА КОМАНДЫ","Подготовить историю\nОпределить аудиторию, выводы и аргументы.\n\nДовести до решения\nОбсудить замечания и выбрать итоговую версию."],
  ["statement","Агент предлагает.\nВы решаете,\nчто войдёт в презентацию.","ПРИНЦИП LANKA","Посмотрите изменения до их применения.\nПримите нужные слайды или отправьте на доработку."],
  ["steps","Начните с задачи.\nАгент уточнит остальное.","ОТ ЗАПРОСА К ПРЕЗЕНТАЦИИ","Уточнить\nАудиторию и нужное решение.\n\nВыстроить\nВыводы и аргументы.\n\nСобрать\nСлайды и материалы.\n\nПроверить\nОбсудить и принять."],
  ["split","Замечание ведёт\nк конкретному изменению","ПРИМЕР РАБОТЫ С ЗАГОЛОВКОМ","Ваше замечание\n«Вынеси ожидаемое решение в заголовок».\n\nПредложение агента\n«Начнём пилот с одной команды»."],
  ["split","Содержание отделено\nот оформления","СЦЕНАРИЙ И ДИЗАЙН","Содержание\nВывод, аргументы, данные и источники каждого слайда.\n\nОформление\nКомпозиция, типографика и правила корпоративного бренда."],
  ["content","Откройте\nрезультат\nпо ссылке","ПРЕЗЕНТАЦИЯ ОСТАЁТСЯ В ПРОЕКТЕ","Посмотреть\nСлайды открываются в браузере.\n\nОтредактировать\nИзмените текст и сохраните версию.\n\nОбсудить\nДайте доступ коллеге и соберите замечания."],
  ["table","Пилот проверяет продукт\nперед внедрением","ГОТОВНОСТЬ ПРОДУКТА",""],
  ["table","Оценим результат\nна вашей презентации","КРИТЕРИИ ПИЛОТА",""],
  ["metrics","Одна команда.\nОдин повторяющийся сценарий.","ПРЕДЛАГАЕМЫЙ ОБЪЁМ","Сценарий и критерии согласуем вместе."],
  ["closing","Выберите задачу\nдля первого пилота.","СЛЕДУЮЩИЙ ШАГ","Назначьте владельца презентации.\nВместе соберём бриф и критерии результата."]
];
after.slides.forEach((s,i)=>{
  const [layout,title,eyebrow,body]=copy[i];
  s.layout=layout as typeof s.layout;s.title=title;s.eyebrow=eyebrow;s.body=body;
  s.notes="Показать пилотный сценарий. Рабочие возможности и ограничения перечислены в источнике. Аудитория и цель остаются рабочими допущениями; цифры пилота — предложение, не результат.\n\n[Sources]\n"+material.name+"\n[/Sources]";
  if(s.intent)s.intent.takeaway=title.replace(/\n/g," ");
});
after.slides[7].table={columns:["Сценарий","В пилоте","Для внедрения"],rows:[["Подготовка","Бриф и план","Агент клиента"],["Правки","Редактор и review","Командный процесс"],["Дизайн","Focus v1","Утверждение бренда"],["Доступ","Права на документ","Организация и SSO"]],sourceId};
after.slides[8].table={columns:["Критерий","Что проверяем","Кто оценивает"],rows:[["Время","Принятый черновик","Владелец задачи"],["Логика","Вывод и аргументы","Бизнес-заказчик"],["Дизайн","Согласованный стиль","Бренд-дизайнер"],["Точность","Данные и источники","Эксперт"]],sourceId};
after.slides[9].metrics=after.slides[9].metrics.map((m,i)=>({...m,label:["Участники пилота","Регулярная задача","Создать и доработать"][i]}));
const client=new ProjectClient(root),store=new ProjectStore(root),events:unknown[]=[];
try{
  await client.call("initialize",{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"lanka-design-review",version:"0.9"}});
  await client.tool("get_authoring_guide");
  const briefing=Object.fromEntries(Object.entries(before.brief!).map(([k,value])=>[k,{value,origin:"assumption"}]));
  const {id,...initialSource}=material;
  events.push({tool:"create_deck",result:await client.tool("create_deck",{requestId:randomUUID(),doc:before,briefing,sources:[initialSource]})});
  const proposal=await client.tool("propose_changes",{requestId:randomUUID(),deckId:before.id,expectedRevision:1,title:"Focus: открытые композиции и конкретный сценарий",changes:after.slides.map(s=>({slideId:s.id,after:s}))});events.push({tool:"propose_changes",result:proposal});
  const pending=(await client.tool("get_project")).state.proposals.find((p:any)=>p.id===proposal.proposalId);
  events.push({action:"User-authorized edit applied through the editor mutation service; browser QA unavailable",result:await humanCommand(store,{requestId:randomUUID(),deckId:before.id,expectedRevision:1,command:{action:"accept",proposalId:proposal.proposalId,changeIds:pending.changes.map((c:any)=>c.id)}})});
  const current=await client.tool("get_project"),revision=current.state.revision;
  const check=await client.tool("lint_deck",{deckId:before.id});events.push({tool:"lint_deck",result:check});
  if(check.overflowSlides.length || check.issues.some((i:any)=>i.severity==="error"))throw new Error(JSON.stringify(check));
  for(const format of ["pptx","pdf"])events.push({tool:"export_deck",result:await client.tool("export_deck",{deckId:before.id,expectedRevision:revision,format})});
  events.push({tool:"export_handoff",result:await client.tool("export_handoff",{deckId:before.id,expectedRevision:revision})});
  await writeFile(resolve("lib/examples/lanka-sales.json"),JSON.stringify({doc:current.state.doc,materials:[material],briefing},null,2));
  await writeFile(resolve(root,"mcp-redesign.json"),JSON.stringify({events},null,2));
  process.stdout.write(JSON.stringify({root,revision,check})+"\n");
}finally{client.close();}
