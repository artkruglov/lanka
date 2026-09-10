import { parseBrief } from "@seekskyworld/creatppt";
import { defaultDesign } from "./design";
import {
  blankSlide,
  defaultBrand,
  uid,
  validateDoc,
  type DeckDoc,
} from "./model";
/** OSS boundary: CreatPPT parses Markdown; only explicit input crosses into our AST. */
export function fromMarkdown(
  markdown: string,
  fallback = "Новая презентация",
): DeckDoc {
  if (!markdown.trim())
    return {
      schemaVersion: 1,
      id: uid(),
      title: fallback,
      brand: structuredClone(defaultBrand),
      design: defaultDesign,
      slides: [{ ...blankSlide("cover"), title: fallback }],
    };
  const brief = parseBrief(markdown, fallback);
  if (brief.sections.length > 40)
    throw new Error(
      "Разделите структуру: в пилоте поддерживается до 40 слайдов.",
    );
  const slides = brief.sections.map((section, i) => ({
    ...blankSlide(i === 0 ? "cover" : "content"),
    title: section.title || fallback,
    eyebrow: i === 0 ? "" : String(i).padStart(2, "0"),
    body: [...section.paragraphs, ...section.bullets.map((b) => "• " + b)].join(
      "\n\n",
    ),
  }));
  if (!slides.length)
    slides.push({
      ...blankSlide("cover"),
      title: brief.title,
      body: brief.subtitle || "",
    });
  return validateDoc({
    schemaVersion: 1,
    id: uid(),
    title: brief.title || fallback,
    brand: structuredClone(defaultBrand),
    design: defaultDesign,
    slides,
  });
}
export function parseCsv(input: string): { label: string; value: number }[] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  const first = input.split("\n")[0];
  const separator = first.includes(";") ? ";" : ",";
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') {
      if (quoted && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === separator || c === "\n")) {
      row.push(cell.trim());
      cell = "";
      if (c === "\n") {
        rows.push(row);
        row = [];
      }
    } else if (c !== "\r") cell += c;
  }
  if (quoted) throw new Error("В CSV не закрыты кавычки.");
  if (cell || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  const useful = rows.filter((r) => r.some(Boolean));
  if (useful[0] && Number.isNaN(Number(useful[0][1]?.replace(",", "."))))
    useful.shift();
  if (useful.length > 8)
    throw new Error("Для диаграммы выберите CSV максимум с 8 строками данных.");
  const values = useful.map((r) => ({
    label: r[0],
    value: Number(r[1]?.replace(",", ".")),
  }));
  if (
    !values.length ||
    values.some(
      (r, i) => !r.label || !useful[i][1]?.trim() || !Number.isFinite(r.value),
    )
  )
    throw new Error("Ожидается CSV с двумя колонками: название, число.");
  return values;
}
