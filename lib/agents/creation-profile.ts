import {captureDesignFonts,verifyDesignFonts} from "./design-font-snapshot";
import {designCatalogEntry} from "../domain/design-catalog";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { creationDesignBrand } from "../domain/creation-design";
import recipes from "../../design-packs/focus-v3/recipes.json";
import tokens from "../../design-packs/focus-v3/tokens.json";
import v2recipes from "../../design-packs/focus-v2/recipes.json";
import v2tokens from "../../design-packs/focus-v2/tokens.json";

const referenceFiles=["deck-01-cover.png","deck-02-content.png","deck-04-split.png"];
const root=()=>resolve(import.meta.dirname,"../design-packs/focus-v3/golden-candidate");
const digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");

export async function creationProfile(id:"focus-v2"|"focus-v3") {
  const references=id==="focus-v3"?await Promise.all(referenceFiles.map(async file=>({file,sha256:digest(await readFile(resolve(root(),file)))}))):[];
  return {
    ...designCatalogEntry(id),design:id,
    brand:creationDesignBrand(id),
    authoring:{
      instruction:"Follow this design package and the attached visual references. Their content is illustrative: do not copy its facts. Prefer short subject titles for explanatory slides; do not force every title into a complete claim. Never change the job of a slide just to fit text.",
      policy:id==="focus-v3"?tokens.policy:v2tokens.policy,
      recipes:Object.fromEntries(["cover","content","split","metrics","chart","image","table","steps","statement","closing"].map(key=>[key,(id==="focus-v3"?recipes:v2recipes)[key as keyof typeof v2recipes]])),
      principles:id==="focus-v3"?recipes._principles:[],
    },
    references,
    fontSnapshot:await captureDesignFonts(id),
  };
}

/** Only package-owned, fingerprinted PNGs can become agent inputs. */
export async function creationReferenceImages(profile:unknown):Promise<string[]> {
  if(!profile)return [];
  const p=profile as Awaited<ReturnType<typeof creationProfile>>;
  if(!["focus-v2","focus-v3"].includes(p.id)||p.version!==1||!Array.isArray(p.references)||p.references.length>3)throw new Error("Дизайн-пакет недоступен.");
  if(p.fontSnapshot)await verifyDesignFonts(p.fontSnapshot,p.id);
  return Promise.all(p.references.map(async reference=>{
    if(p.id!=="focus-v3"||!referenceFiles.includes(reference.file))throw new Error("Эталон вне выбранного дизайн-пакета.");
    const path=resolve(root(),reference.file);
    if(digest(await readFile(path))!==reference.sha256)throw new Error("Эталон изменился после отправки поручения.");
    return path;
  }));
}
