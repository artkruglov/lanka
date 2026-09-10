/** Installed package discovery shared by the editor and both MCP transports.
 * version describes this catalog contract, not an immutable renderer release.
 */
export const designCatalog = [
  {id:"focus-v3",version:1,status:"candidate",name:"Focus 3",statusLabel:"Предварительная версия",description:"Крупная типографика и спокойный фон. Для рассказа о продукте, предложений и коротких отчётов.",useFor:["Объяснение идеи","Сравнение было/предложено","План действий"],avoidFor:["Плотные таблицы без разделения","Произвольная свободная вёрстка"],visualReferences:3,fonts:["IBM Plex Sans","IBM Plex Mono"],note:"Кандидат, не сертифицированный корпоративный шаблон. Явно выберите для новой деки; существующие документы сохраняют свой дизайн."},
  {id:"focus-v2",version:1,status:"legacy",name:"Focus 2",statusLabel:"Прежний шаблон",description:"Контрастные акценты и привычные колонки. Для продолжения материалов в прежнем оформлении.",useFor:["Продолжение существующих документов Focus 2"],avoidFor:["Автоматическая подмена выбранного Focus 3"],visualReferences:0,fonts:["DejaVu Sans"],note:"Существующее оформление. Не улучшает композицию за счёт смены содержания."},
] as const;
export function designCatalogEntry(id:"focus-v2"|"focus-v3") {
  return designCatalog.find(entry=>entry.id===id)!;
}
