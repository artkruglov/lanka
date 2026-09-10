# Focus 3: внедрение и проверка, 6 сентября 2026

## Применено

Пакет взят из `~/Downloads/lanka-fable-design-review/handoff-focus-v3/`. Скопированы tokens, recipes, 11 fixtures, reference, golden-candidate, пример из девяти слайдов, рендерер, метрики, скрипт генерации метрик и три шрифта с обеими лицензиями OFL.

Добавлены ID дизайна, ветка `scene`, необязательные `comparison` и `columnRoles`, контракт authoring, lint и design-review. Новый starter использует собственный ключ идемпотентности и существующий механизм личных копий. Галерея использует фикстуры v3. В редакторе добавлены поля сравнения, в командах агента — `set_comparison`, с прежним процессом предложения/принятия.

Экспорты браузера и локального MCP используют Plex. `pptxBytes` — граница готового PPTX: она дополняет палитру в OOXML после `buildPptx`. `buildPptx` остаётся низкоуровневым построителем PptxGenJS; для конечных v3-файлов нужно вызывать `pptxBytes`. SVG доступен через `slideSvg`; проверочный скрипт сохраняет самостоятельные SVG со встроенными TTF и HTML с настоящим компонентом `SlideCanvas`.

## Расхождения с выдержками

1. В реальном `Primitive` уже был `editField`; он сохранён. Кроме `font`/`tracking` добавлен необязательный `lineHeight` в em. Он переносит точную высоту строки из измеренного блока во все экспортеры. В handoff HTML она угадывалась по кеглю: для numeral 96 px получалось 1,04 вместо 1,0. Исправление базовой линии объясняет небольшую разницу с hero-кандидатом.
2. Локальные дубли типов `SlideV3` и `Comparison` заменены настоящим типом `Slide`. `Scene.meta` доступно через общий диспетчер. Геометрия, токены, контент и правила вариантов не менялись.
3. Новые правила lint ограничены дизайном v3, чтобы не добавлять ошибки старым документам.
4. Шрифты проекта находятся в `public/fonts`. У локального веб-сервера явный список статики: в него добавлены все три файла. У CSS `.slide-canvas text` был старый font-family; для v3 семейство задано inline, иначе атрибут SVG перекрывался бы CSS.
5. В TTF SemiBold из пакета `usWeightClass=600`, но имена семейства/начертания/PostScript указывали Regular. Исправлена только таблица `name` скриптом `scripts/normalize-plex-fonts.py`. Повторная генерация подтвердила полное равенство `widths` и `vertical` прежним JSON-метрикам. Контуры не изменены.
6. pdf-lib кодирует глифы, но не применяет позиции кернинга из fontkit. В ветке Plex PDF выводит глифы по позициям fontkit и добавляет tracking. Все шрифты встраиваются с `subset:true`, имена подмножеств имеют стандартный шестибуквенный префикс. Ветки DejaVu сохраняют прежний вывод.
7. PptxGenJS 4.0.1 предоставляет тему шрифтов, но не API палитры. Готовый ZIP получает брендовые dk1/lt1/accent1/accent2 и остальные роли темы. Tracking задаётся через `charSpacing` в пунктах; XML содержит `spc=round(tracking*size*0.6*100)`. Строки сцены экспортируются без повторного переноса.
8. В `docs/PRODUCT_V11.md` уже описан другой этап. Поэтому продуктовый документ дизайна добавлен отдельно: `PRODUCT_V11_FOCUS3.md`.

## Команды и результаты

```sh
npm ci --no-audit --no-fund
npx tsc --noEmit --pretty false
npm test
npm run test:focus-v3
mkdir -p out/focus-v3/test-tmp
TMPDIR="$PWD/out/focus-v3/test-tmp" npm run test:project
```

- TypeScript: exit 0.
- Domain: 64/64 (59 существующих тестов без изменения их сценариев + 5 новых групп v3).
- Production build: exit 0; маршрут `/examples/lanka-sales-focus-v3` включён.
- Project MCP/editor: 11/11, включая реальный экспорт v3 через stdio MCP и проверку байтов TTF через локальные HTTP-маршруты.
- ESLint изменённых файлов реализации v3: exit 0.
- На macOS стандартный tmpdir может содержать `/var` → `/private/var`; существующий `ProjectStore` отклоняет такой путь. Для старых project-тестов использован настоящий каталог `out/focus-v3/test-tmp`; код проверки путей не ослаблен.

`npm run test:focus-v3` собирает и запускает `scripts/render-fixtures.ts` через esbuild/Node. Его также можно вызвать напрямую: `bun scripts/render-fixtures.ts`. Для растеризации нужны Chrome/Chromium и Poppler. `CHROME_PATH` позволяет задать браузер. Эталоны не перезаписываются; принятый каталог `golden/` не создавался.

```text
slides: 20
failures: 0
lint: []
web: 20/20; max diff 0.058% (limit 0.5%)
pdf: 20/20; max diff 0.383% (limit 0.5%)
```

Сравнение выполняется в 1600×900: pixelmatch, цветовой threshold 0.1, антиалиасинг исключён, допускается ≤0.005 доли отличающихся пикселей. Проверяется реальный `SlideCanvas` с legacy CSS, а не отдельный макет. Все самостоятельные SVG используют тот же `textStyle`. Для SVG из первого прогона получен тот же максимум 0,058%.

### Девять слайдов примера

| Слайд | Вариант | titleFill | occupancy | contentHeight | primaryTextClasses |
| --- | --- | --- | --- | --- | --- |
| 1 | default | 0.84 | 0.310 | 334 | 1 |
| 2 | cols | 0.61 | 0.172 | 145 | 0 |
| 3 | cols | 0.82 | 0.168 | 175 | 0 |
| 4 | before-after | 0.64 | 0.301 | 327 | 1 |
| 5 | default | 0.62 | 0.240 | 66 | 0 |
| 6 | auto | 0.64 | 0.221 | 354 | 0 |
| 7 | facts | 0.61 | 0.181 | 291 | 0 |
| 8 | cols | 0.87 | 0.236 | 145 | 0 |
| 9 | default | 0.67 | 0.245 | 66 | 0 |

Переполнений нет во всех 11 фикстурах и 9 слайдах примера. У примера `titleFill≤0.90`, `occupancy` внутри 0.12…0.42, `primaryTextClasses≤1`. Четвёртый слайд — before-after, седьмой — facts. Источник и его зарегистрированный материал совпадают с v2. Lint не содержит ошибок или предупреждений о ритме.

`designReview` намеренно сообщает два замечания minContentHeight для слайдов 2 и 8: 145<150. У отдельной фикстуры split/options высота 147<150. Это исходное противоречие пакета, а не результат миграции. Порог и композиции сохранены. Полное соответствие всем полям `tokens.policy` не заявляется.

### PDF

```sh
pdffonts out/focus-v3/deck.pdf
pdffonts out/focus-v3/fixture.pdf
```

```text
LNKMON+IBMPlexMono-Medium     CID TrueType  Identity-H  yes yes yes
LNKSBD+IBMPlexSans-SemiBold   CID TrueType  Identity-H  yes yes yes
LNKREG+IBMPlexSans-Regular    CID TrueType  Identity-H  yes yes yes
```

Колонки после encoding: emb/sub/uni. DejaVu отсутствует. PDF имеет 9 и 11 страниц, кириллица извлекается через pdftotext. Композиции примера и дополнительные options/hero/chart просмотрены после растеризации; контактный лист сохранён в `out/focus-v3/contact-sheet.png`.

### PPTX

Проверка ZIP/XML: 9/11 слайдов, редактируемые текст и фигуры, Plex Sans/Mono, положительный и отрицательный tracking. Тема содержит accent1 `444BE8`, accent2 `A9AEFF`, dk1 `15182A`, lt1 `F6F6F3`. TTF в PPTX не встроены: это оставлено открытым решением владельца, как в handoff.

Для дополнительной проверки использован bundled LibreOffice, без изменения системных шрифтов. Команда с абсолютным путём к `dependencies/bin/override/soffice` из runtime:

```sh
FONTCONFIG_FILE="$PWD/out/focus-v3/fonts.conf" "$SOFFICE_PATH" \
  --headless --convert-to pdf --outdir "$PWD/out/focus-v3/pptx-pdf" \
  "$PWD/out/focus-v3/deck.pptx" "$PWD/out/focus-v3/fixture.pptx"
pdftoppm -scale-to-x 1600 -scale-to-y 900 -png \
  out/focus-v3/pptx-pdf/deck.pdf out/focus-v3/pptx-png/deck
```

LibreOffice конвертировал оба файла, но изменил начертания и интервалы. Расхождение PNG: 1,470–3,620%, все 20 слайдов выше порога 0,5%. Это **не пройденный** визуальный golden-diff PPTX. JSON результатов: `out/focus-v3/pptx-golden-diff.json`. PowerPoint, Keynote и Google Slides не проверены. Следующее решение владельца — встраивание шрифтов с проверкой в целевом редакторе или признание PDF каноническим экспортом. До этого нельзя считать кроссредакторную точность PPTX подтверждённой.

## Границы результата

`defaultDesign` и defaultBrand сохранены. `focus-v1`, `focus-v2`, их рендереры, `scene-text.ts`, `font-metrics.json` и прежние примеры не изменены. Работа велась с тестовыми копиями; сохранённые пользовательские документы и публикации не затронуты. Изображения и иконки не генерировались. Статус дизайна остаётся candidate, человеческая приёмка не выполнена.

Повторяемые результаты и журналы находятся в `out/focus-v3/` (каталог исключён из git): `deck.pdf`, `deck.pptx`, `fixture.pdf`, `fixture.pptx`, 20 SVG, 20 HTML, `metrics.json`, `golden-diff.json`, PNG и журналы проверок.
