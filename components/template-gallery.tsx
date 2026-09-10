"use client";
import { useMemo, useState } from "react";
import { designNames, designOptions, defaultDesign, type Design } from "@/lib/domain/design";
import type { Brand } from "@/lib/domain/model";
import { layoutNames, blankSlide, validateDoc, defaultBrand } from "@/lib/domain/model";
import focusFixtures from "../design-packs/focus-v1/fixtures.json";
import focus2Fixtures from "../design-packs/focus-v2/fixtures.json";
import focus3Fixtures from "../design-packs/focus-v3/fixtures.json";
import { recipeGuides, recipeSamples } from "@/lib/domain/recipes";
import { SlideCanvas } from "./slide-canvas";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select";
export function TemplateGallery({ brands }: { brands: Brand[] }) {
  const [brandId, setBrandId] = useState(brands[0]?.id ?? "");
  const [design, setDesign] = useState<Design>(defaultDesign);
  const samples = useMemo(()=>design==="focus-v1"||design==="focus-v2"||design==="focus-v3"?validateDoc({schemaVersion:1,id:"focus-fixtures",title:"Focus",brand:defaultBrand,design,slides:(design==="focus-v3"?focus3Fixtures:design==="focus-v2"?focus2Fixtures:focusFixtures.filter(s=>s.layout!=="image")).map(s=>({...blankSlide(),...s}))}).slides:recipeSamples(), [design]);
  const brand = brands.find((b) => b.id === brandId) ?? brands[0];
  if (!brand) return null;
  return (
    <section className="mt-10">
      <div className="workspace-heading">
        <div>
          <span className="eyebrow">КОМПОЗИЦИИ И ИХ ЗАДАЧИ</span>
          <h2>Визуальный язык презентации</h2>
          <a className="text-primary underline" href="/examples/lanka-sales-focus-v2">Открыть презентацию Lanka в Focus 2</a>
          <p><a className="text-primary underline" href="/examples/lanka-sales-focus-v3">Посмотреть Focus 3 — редакционный</a></p>
          <p className="hint">
            {designNames[design]} — примеры композиций с выбранным брендом. Переключение здесь меняет только предпросмотр, а не ваши презентации.
          </p>
        </div>
        <div className="row flex-wrap">
        <Select value={design} onValueChange={v => setDesign(v as Design)}>
          <SelectTrigger className="w-[270px]"><SelectValue /></SelectTrigger>
          <SelectContent>{designOptions.map(d => <SelectItem key={d} value={d}>{designNames[d]}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={brand.id} onValueChange={setBrandId}>
          <SelectTrigger className="w-[230px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {brands.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        </div>
      </div>
      <div className="deck-grid">
        {samples.map((s, i) => (
          <article className="deck-card" key={s.id}>
            <SlideCanvas
              slide={s}
              brand={brand} design={design}
              index={i}
              total={samples.length}
            />
            <div className="deck-card-info">
              <h3>{layoutNames[s.layout]}</h3>
              <p className="hint mt-2">{recipeGuides[s.layout].purpose}</p>
              <p className="hint mt-3">{recipeGuides[s.layout].budget}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
