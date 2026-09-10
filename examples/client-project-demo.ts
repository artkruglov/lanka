import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  blankSlide,
  defaultBrand,
  uid,
  type Slide,
  type DeckDoc,
} from "../lib/domain/model";
import { ProjectClient } from "../scripts/project-mcp/client.mjs";
const root = resolve(process.argv[2]);
await mkdir(root, { recursive: true });
const make = (
  layout: Slide["layout"],
  title: string,
  body: string,
  role: NonNullable<Slide["intent"]>["role"],
  transition: string,
): Slide => ({
  ...blankSlide(layout),
  title,
  body,
  eyebrow: "LANKA · КЛИЕНТСКИЙ ПРОЕКТ",
  intent: {
    role,
    takeaway: title.replace(/\n/g, " "),
    transition,
    openQuestions: [],
  },
  notes:
    "Предложение целевого сценария продукта. Это демонстрация концепции, не отчёт о внедрённых корпоративных возможностях. Основание: требования заказчика в текущем обсуждении.",
});
const doc: DeckDoc = {
  schemaVersion: 1,
  id: uid(),
  title: "Lanka — презентации в пространстве клиента",
  brand: { ...defaultBrand },
  design: "atelier-v1",
  brief: {
    audience: "Команда продукта и руководитель клиентского пилота",
    decision:
      "Принять отдельное пространство клиента как базовую модель хранения и запуска агента",
    keyMessage:
      "Клиент контролирует документы и доступ; агент работает только с выбранным проектом.",
  },
  slides: [
    make(
      "cover",
      "Презентации\nв пространстве клиента",
      "Проектный подход к совместной работе с агентом",
      "context",
      "Почему нужно ограничить контекст исполнителя?",
    ),
    make(
      "statement",
      "Один запуск —\nодин клиентский проект",
      "Агент получает материалы конкретной задачи. Границу проекта проверяет подключение.",
      "recommendation",
      "Что именно должно находиться в проекте?",
    ),
    make(
      "split",
      "Проект хранит\nсодержание и историю",
      "Материалы\nБриф, источники и шаблон клиента.\n\nРезультат\nСлайды, замечания и предложения изменений.",
      "context",
      "Как сотрудник работает с этим набором?",
    ),
    make(
      "steps",
      "От брифа\nк проверенному результату",
      "Поручить\nВыбрать проект и описать задачу.\n\nПроверить\nОбсудить план и просмотреть слайды.\n\nДоработать\nПринять изменения и сохранить результат.",
      "recommendation",
      "Как сохранить контроль над доступом?",
    ),
    make(
      "split",
      "Хранилище управляет доступом.\nАгент выполняет задачу.",
      "Сотрудники\nРаботают с доступной им папкой и проверяют изменения.\n\nИсполнитель\nПолучает только этот проект и возвращает предложение.",
      "recommendation",
      "Что необходимо проверить в первом пилоте?",
    ),
    make(
      "content",
      "Пилот должен доказать\nцелый рабочий сценарий",
      "Создание презентации из реальных материалов.\n\nПравка человеком и доработка агентом без потери изменений.\n\nПередача коллеге через выбранное хранилище.",
      "decision",
      "С какого проекта начинаем проверку?",
    ),
    make(
      "closing",
      "Начнём с одного\nклиентского проекта",
      "Выбрать папку, корпоративный шаблон и повторяющуюся задачу команды.",
      "next_step",
      "",
    ),
  ],
};
const client = new ProjectClient(root),
  events = [];
try {
  const init = await client.call("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "codex-work-project-demo", version: "0.7.0" },
  });
  events.push({ method: "initialize", result: init.result });
  const made = await client.tool("create_deck", {
    briefing: Object.fromEntries(Object.entries(doc.brief!).map(([key,value])=>[key,{value,origin:"assumption"}])) ,
    requestId: randomUUID(),
    doc,
  });
  events.push({ tool: "create_deck", result: made });
  const check = await client.tool("lint_deck", { deckId: made.deckId });
  events.push({ tool: "lint_deck", result: check });
  if (check.overflowSlides.length)
    throw new Error("Demo overflows: " + JSON.stringify(check.overflowSlides));
  for (const format of ["pptx", "pdf"]) {
    const artifact = await client.tool("export_deck", {
      deckId: made.deckId,
      expectedRevision: 1,
      format,
    });
    events.push({ tool: "export_deck", format, result: artifact });
  }
  const p = await client.tool("get_project");
  await mkdir(resolve(root, "presentation"), { recursive: true });
  await writeFile(
    resolve(root, "presentation/deck.json"),
    JSON.stringify(p.state.doc, null, 2),
  );
  await writeFile(
    resolve(root, "mcp-run.json"),
    JSON.stringify(
      {
        execution:
          "Real local stdio MCP calls from the current assistant; no separate authenticated Codex model run",
        events,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    JSON.stringify({
      root,
      deckId: made.deckId,
      slides: made.slideCount,
      overflow: check.overflowSlides.length,
      issues: check.issues,
      narrative: check.narrative,
    }) + "\n",
  );
} finally {
  client.close();
}
