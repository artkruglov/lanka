/** Idempotent local demo: every document is authored through the real stdio MCP. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { ProjectClient } from "./project-mcp/client.mjs";
const origin = process.env.LANKA_ORIGIN || "http://127.0.0.1:4317";
const workspace = resolve(process.env.LANKA_WORKSPACE || "work/local-library");
const landing = await fetch(origin),
  cookie = landing.headers.get("set-cookie").split(";")[0];
const headers = {
  Cookie: cookie,
  Origin: origin,
  "Content-Type": "application/json",
};
async function catalog(requestId, command) {
  const r = await fetch(origin + "/api/library", {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId, command }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error);
  return d;
}
const folder = "fe80c5b6-dc64-4d84-bbeb-671aa43ff080";
await catalog(folder, { action: "create_folder", name: "История цивилизаций" });
const seed = JSON.parse(
  await readFile("lib/examples/lanka-sales-focus-v3.json", "utf8"),
);
const source = `# Источники для учебных демонстраций\nПроверено 6 сентября 2026. Русский конспект; не исчерпывающая история цивилизаций.\n\nBritish Museum — Mesopotamia\nhttps://www.britishmuseum.org/collection/galleries/mesopotamia\nНебольшие земледельческие поселения Междуречья выросли в города. Экономика опиралась на сельское хозяйство. Предметы музея свидетельствуют о развитии письма, технологий, искусства и ремёсел у шумеров, аккадцев и вавилонян. Царское кладбище Ура дало археологам украшения, керамику и музыкальные инструменты.\n\nUNESCO — About the Silk Roads\nhttps://www.unesco.org/en/silk-roads/about-silk-roads\nШёлковые пути образовали меняющуюся сеть сухопутных и морских маршрутов Евразии. По ним перевозили шёлк, пряности, зерно, металлы и другие товары. Вместе с путешественниками распространялись языки, идеи, верования, технологии производства бумаги. Города и порты служили местами торговли и обмена знаниями. Купцы обычно проходили отдельные участки пути, перепродавая товары посредникам. Караван-сараи давали отдых, пищу и возможность встреч. Название сети появилось лишь в XIX веке.\n`;
const sourceId = "src-" + createHash("sha256").update(source).digest("hex");
const slides = (rows, prefix) =>
  rows.map(([layout, title, body, extra = {}], i) => ({
    id: `${prefix}-${i + 1}`,
    layout,
    title,
    eyebrow: "История цивилизаций",
    body,
    notes:
      "Учебный обзор. Источники: British Museum и UNESCO; ссылки и сохранённый конспект приложены к документу.",
    metrics: [],
    chart: [],
    chartUnit: "",
    sourceIds: [sourceId],
    intent: {
      role:
        i === 0 ? "context" : layout === "closing" ? "next_step" : "evidence",
      takeaway: title.replaceAll("\n", " "),
      transition:
        i === rows.length - 1 ? "" : rows[i + 1][1].replaceAll("\n", " "),
      openQuestions: [],
    },
    ...extra,
  }));
const demos = [
  {
    id: "7534ae80-b420-45e3-9933-83a56762a101",
    title: "Цивилизации: города, письмо и связи",
    prefix: "cities",
    rows: [
      [
        "cover",
        "Цивилизации.\nГорода, письмо и связи.",
        "От поселений Междуречья до торговых сетей Евразии. Краткое введение в историю общих связей.\n\nУчебная демонстрация · Focus 3",
      ],
      [
        "content",
        "Город объединяет разные занятия",
        "Земледелие\nХозяйство Междуречья опиралось на сельское хозяйство.\n\nРемесло\nМастера создавали керамику, украшения и инструменты.\n\nПисьмо\nРазвитие городов сопровождалось появлением письма.",
      ],
      [
        "table",
        "Вещи помогают читать прошлое",
        "Коллекция Британского музея · Междуречье",
        {
          table: {
            columns: ["Свидетельство", "Что изучаем", "Пример"],
            columnRoles: ["key", "text", "meta"],
            rows: [
              ["Поселения", "Развитие городов", "Междуречье"],
              ["Предметы быта", "Ремесло и технологии", "Керамика"],
              ["Погребения", "Искусство и обычаи", "Царское кладбище Ура"],
            ],
          },
        },
      ],
      [
        "content",
        "Связи выходят за границы городов",
        "Суша\nКараваны связывали города через отдельные участки пути.\n\nМоре\nПорты соединяли торговые сети береговых обществ.\n\nОбмен\nВместе с товарами путешествовали знания и верования.",
      ],
      [
        "statement",
        "История цивилизаций —\nэто история связей.",
        "Сравнивая города, вещи и маршруты, мы видим контакты между обществами.",
      ],
      [
        "closing",
        "Продолжим исследование.",
        "Выберите город или предмет и проследите его связи с соседями.\n\nНачать можно с Ура и его археологических находок.",
      ],
    ],
  },
  {
    id: "7534ae80-b420-45e3-9933-83a56762a102",
    title: "Шёлковые пути: товары и идеи",
    prefix: "roads",
    rows: [
      [
        "cover",
        "Шёлковые пути.\nТовары и идеи.",
        "Торговые сети Евразии соединяли людей по суше и по морю.\n\nУчебная демонстрация · Focus 3",
      ],
      [
        "content",
        "Маршруты менялись со временем",
        "Товары\nШёлк, пряности, зерно и металлы переходили от купца к купцу.\n\nВстречи\nГорода и караван-сараи давали отдых и место для торговли.\n\nЗнания\nПутешественники передавали идеи и технологии изготовления бумаги.",
      ],
      [
        "split",
        "От линии на карте к сети связей",
        "По материалам UNESCO",
        {
          comparison: {
            prompt: {
              label: "Как читать карту",
              text: "Представьте путь одного товара через несколько рынков.",
            },
            before: {
              label: "Упрощённая картина",
              text: "Один маршрут. Один купец проходит весь путь.",
            },
            after: {
              label: "Более точная картина",
              text: "Много маршрутов. Товар передают через цепочку посредников.",
            },
            status: "Учебное сравнение представлений",
          },
        },
      ],
      [
        "closing",
        "Проследите путь идеи.",
        "Как знания могли двигаться вместе с людьми и товарами?\n\nОбсудите пример производства бумаги.",
      ],
    ],
  },
];
const receipts = [];
for (const d of demos) {
  await catalog(d.id, {
    action: "create_document",
    title: d.title,
    folderId: folder,
  });
  const root = join(workspace, "documents", d.id),
    client = new ProjectClient(root);
  try {
    await client.tool("get_authoring_guide");
    await client.tool("get_briefing_questions");
    const doc = {
      schemaVersion: 1,
      id: d.id,
      title: d.title,
      brand: seed.doc.brand,
      design: "focus-v3",
      slides: slides(d.rows, d.prefix),
    };
    const briefing = {
      audience: {
        value:
          "Широкая аудитория без специальной подготовки; рабочее допущение для простой учебной демонстрации.",
        origin: "assumption",
      },
      decision: {
        value:
          "Проверить создание исторической презентации через MCP и удобство редактора.",
        origin: "user",
      },
      keyMessage: {
        value:
          "История городов, письма и торговых связей помогает увидеть взаимодействие обществ.",
        origin: "assumption",
      },
    };
    await client.tool("create_deck", {
      requestId: d.id,
      doc,
      briefing,
      sources: [
        {
          name: "history-sources.md",
          contentType: "text/markdown",
          base64: Buffer.from(source).toString("base64"),
        },
      ],
    });
    const p = await client.tool("get_project"),
      lint = await client.tool("lint_deck", { deckId: d.id });
    const exports = [];
    for (const format of ["pdf", "pptx"])
      exports.push(
        await client.tool("export_deck", {
          deckId: d.id,
          expectedRevision: p.state.revision,
          format,
        }),
      );
    receipts.push({
      id: d.id,
      title: d.title,
      url: `${origin}/documents/${d.id}`,
      root,
      revision: p.state.revision,
      lint,
      exports,
    });
  } finally {
    client.close();
  }
}
await mkdir("out/local-review", { recursive: true });
await writeFile(
  "out/local-review/mcp-receipts.json",
  JSON.stringify(receipts, null, 2),
);
console.log(JSON.stringify(receipts, null, 2));
