import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const origin = "http://127.0.0.1:4317",
  id = "7534ae80-b420-45e3-9933-83a56762a101";
const browser = await chromium.launch({
    headless: true,
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const checks = [];
try {
  await page.goto(origin);
  await page.getByRole("heading", { name: "Все презентации" }).waitFor();
  await page
    .getByRole("button", { name: "Создать папку", exact: true })
    .click();
  await page.getByRole("textbox").last().fill("Для обсуждения");
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await page
    .getByRole("button", { name: "Для обсуждения", exact: true })
    .waitFor();
  checks.push("create folder through UI");
  await page
    .getByRole("textbox", { name: "Поиск презентаций" })
    .fill("Шёлковые");
  assert.equal(await page.locator(".library-card").count(), 1);
  await page.getByRole("textbox", { name: "Поиск презентаций" }).fill("");
  await page
    .getByLabel("Папка: Шёлковые пути: товары и идеи", { exact: true })
    .selectOption({ label: "Для обсуждения" });
  await page
    .getByRole("button", { name: "Для обсуждения", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Для обсуждения", exact: true })
    .waitFor();
  assert.equal(await page.locator(".library-card").count(), 1);
  checks.push("search and move into folder");
  await page
    .getByRole("button", {
      name: "В корзину: Шёлковые пути: товары и идеи",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Корзина", exact: true }).click();
  await page.getByRole("button", { name: "Восстановить", exact: true }).click();
  await page
    .getByRole("button", { name: "Все презентации", exact: true })
    .click();
  await page
    .getByLabel("Папка: Шёлковые пути: товары и идеи", { exact: true })
    .selectOption({ label: "История цивилизаций" });
  checks.push("trash and restore");
  await page.screenshot({
    path: "out/local-review/library.png",
    fullPage: true,
  });
  await page
    .getByRole("link", {
      name: "Открыть: Цивилизации: города, письмо и связи",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: /Слайд 2:/ }).click();
  await page
    .locator(".project-main-slide")
    .getByRole("button", {
      name: "Редактировать: Город объединяет",
      exact: true,
    })
    .click();
  assert.equal(
    await page
      .locator("#slide-title-field")
      .evaluate((e) => document.activeElement === e),
    true,
  );
  checks.push("click slide selects actual title field");
  await page
    .getByRole("textbox", { name: "Заголовок", exact: true })
    .fill("Город соединяет разные занятия");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page.getByText("Сохранено · версия 2", { exact: true }).waitFor();
  await page.reload();
  await page
    .getByRole("button", {
      name: "Слайд 2: Город соединяет разные занятия",
      exact: true,
    })
    .waitFor();
  checks.push("edit save and reload");
  await page.getByRole("tab", { name: "История", exact: true }).click();
  await page.getByRole("button", { name: /Версия 1/ }).click();
  await page
    .getByRole("button", { name: "Восстановить эту версию", exact: true })
    .click();
  await page.getByText("Сохранено · версия 3", { exact: true }).waitFor();
  checks.push("compare and restore previous version as new revision");
  await page.getByRole("button", { name: /Слайд 2:/ }).click();
  await page.getByRole("button", { name: "Комментарии", exact: true }).click();
  await page
    .getByPlaceholder("Что изменить и почему?")
    .fill(
      "Для учебной демонстрации сократи заголовок до «Город объединяет людей». Основной текст и факты оставь прежними.",
    );
  await page
    .getByRole("button", { name: "Сохранить замечание", exact: true })
    .click();
  await page
    .getByText(
      "Для учебной демонстрации сократи заголовок до «Город объединяет людей». Основной текст и факты оставь прежними.",
      { exact: true },
    )
    .waitFor();
  checks.push("save anchored human comment");
  await page.getByRole("button", { name: "Показать", exact: true }).click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  checks.push("presentation keyboard navigation and escape");
  await page.getByRole("button", { name: "Содержание", exact: true }).click();
  await page.screenshot({
    path: "out/local-review/editor.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await writeFile(
    "out/local-review/browser-checks.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(checks);
} finally {
  await browser.close();
}
