import { chromium } from "playwright";
import { ProjectClient } from "./project-mcp/client.mjs";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const origin = "http://127.0.0.1:4317",
  cities = "7534ae80-b420-45e3-9933-83a56762a101",
  roads = "7534ae80-b420-45e3-9933-83a56762a102";
const browser = await chromium.launch({
    headless: true,
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  }),
  page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  }),
  errors = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
const client = new ProjectClient(
    process.cwd() + "/work/local-library/documents/" + cities,
  ),
  other = new ProjectClient(
    process.cwd() + "/work/local-library/documents/" + roads,
  );
try {
  const already = await client.tool("get_project");
  let accepted;
  if (
    already.state.proposals.some(
      (p) => p.status === "pending" && p.feedbackIds?.length,
    )
  ) {
    await page.goto(origin + "/documents/" + cities);
    await page.getByRole("button", { name: /Слайд 2:/ }).click();
    await page
      .getByRole("button", { name: "Комментарии", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Проверить изменения", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Изменения на проверку", exact: true })
      .waitFor();
    assert.equal(await page.locator(".project-stage").isVisible(), true);
    assert.equal(await page.locator(".project-inspector").isVisible(), false);
    checks.push("mobile comment reply opens visible comparison");
    await page.locator(".review-text-diff").waitFor();
    await page.screenshot({
      path: "out/local-review/mobile-review.png",
      fullPage: true,
    });
    assert.ok(await page.locator(".review-text-diff").innerText());
    const horizontal = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    assert.equal(horizontal, false);
    checks.push("390 px mobile review has no horizontal page overflow");
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: /Принять выбранные/ }).click();
    await page
      .getByRole("heading", {
        name: "Нет изменений, ожидающих решения",
        exact: true,
      })
      .waitFor();
    accepted = await client.tool("get_project");
    assert.equal(accepted.state.doc.slides[1].title, "Город объединяет людей");
    assert.equal(
      accepted.state.comments.find(
        (c) => c.author === "Владелец проекта" && !c.replyTo,
      )?.resolved,
      true,
    );
    checks.push(
      "human accepts actual model change and linked comment resolves",
    );
  } else {
    accepted = already;
    assert.equal(accepted.state.doc.slides[1].title, "Город объединяет людей");
    assert.equal(
      accepted.state.comments.find(
        (c) => c.author === "Владелец проекта" && !c.replyTo,
      )?.resolved,
      true,
    );
    checks.push(
      "previous mobile acceptance preserved; original screenshot retained",
    );
  }
  // Leave concrete pending changes in both demos for the owner to try.
  await client.tool("propose_commands", {
    requestId: randomUUID(),
    deckId: cities,
    expectedRevision: accepted.state.revision,
    title: "Уточнить рубрику на историческом примере",
    commands: [
      {
        op: "set_title",
        slideId: "cities-3",
        value: "Археология помогает читать прошлое",
      },
    ],
  });
  const p = await other.tool("get_project");
  await other.tool("propose_commands", {
    requestId: randomUUID(),
    deckId: roads,
    expectedRevision: p.state.revision,
    title: "Уточнить два заголовка для обсуждения",
    commands: [
      {
        op: "set_title",
        slideId: "roads-2",
        value: "Товары и знания движутся вместе",
      },
      { op: "set_title", slideId: "roads-4", value: "Как путешествуют идеи?" },
    ],
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + "/documents/" + roads + "?review=1");
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: /Принять выбранные/ }).click();
  await page.waitForFunction(() =>
    document.body.innerText.includes("Сохранено · версия 2"),
  );
  const partial = await other.tool("get_project");
  assert.equal(
    partial.state.proposals
      .at(-1)
      .changes.filter((c) => c.status === "accepted").length,
    1,
  );
  assert.equal(
    partial.state.proposals.at(-1).changes.filter((c) => c.status === "pending")
      .length,
    1,
  );
  checks.push(
    "partial acceptance changes only the selected slide; another remains pending",
  );
  await page.screenshot({
    path: "out/local-review/desktop-review.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/documents/" + roads);
  await page.getByRole("button", { name: /Слайд 3:/ }).click();
  const target = page
    .locator(".project-main-slide [role=button]")
    .filter({ hasText: "Много маршрутов." })
    .first();
  await target.click();
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("data-edit-field") ===
      "comparison:after:text",
  );
  assert.equal(await page.locator(".project-inspector").isVisible(), true);
  checks.push("mobile comparison text opens the exact inspector field");
  await page.screenshot({
    path: "out/local-review/mobile-editor.png",
    fullPage: true,
  });
  await page.goto(origin);
  await page.screenshot({
    path: "out/local-review/mobile-library.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  checks.push("mobile document library fits viewport");
  // Export via visible UI and check file download.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + "/documents/" + cities);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  const file = await downloading;
  await file.saveAs("out/local-review/browser-export.pdf");
  checks.push("PDF downloaded through editor UI");
  assert.deepEqual(errors, []);
  await writeFile(
    "out/local-review/review-browser-checks.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(checks);
} finally {
  client.close();
  other.close();
  await browser.close();
}
