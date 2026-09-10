import {scopedApiPath} from '../lib/project/browser-context';
import { scene, W, H, type Primitive } from "@/lib/domain/scene";
import { textStyle } from "@/lib/domain/scene-typography";
import { imagePlacement } from '@/lib/domain/image-frame';
import type { Brand, Slide, DeckDoc } from "@/lib/domain/model";
export function SlideCanvas({
  slide,
  brand,
  design,
  index = 0,
  total = 1,
  selectedField,
  onSelectField,
  assetBaseUrl = "/api/assets",
  hiddenTextId,
  onImageError,
}: {
  slide: Slide;
  brand: Brand;
  design?: DeckDoc["design"];
  index?: number;
  total?: number;
  selectedField?: string | null;
  onSelectField?: (field: string) => void;
  assetBaseUrl?: string;
  hiddenTextId?: string;
  onImageError?:()=>void;
}) {
  return <SceneCanvas items={scene(slide,brand,index,total,design).items} title={slide.title} selectedField={selectedField} onSelectField={onSelectField} assetBaseUrl={assetBaseUrl} hiddenTextId={hiddenTextId} onImageError={onImageError}/>;
}
export function SceneCanvas({items,title,selectedField,onSelectField,assetBaseUrl="/api/assets",hiddenTextId,assetUrl,onImageError}:{
  items:Primitive[];title:string;selectedField?:string|null;onSelectField?:(field:string)=>void;assetBaseUrl?:string;hiddenTextId?:string;assetUrl?:(id:string)=>string;onImageError?:()=>void;
}) {
  const imageUrl=assetUrl??((id:string)=>{const assets=scopedApiPath(assetBaseUrl);return `${assets}${assets.includes("?")?"&":"?"}id=${encodeURIComponent(id)}`;});
  return (
    <svg
      className="slide-canvas"
      viewBox={`0 0 ${W} ${H}`}
      role={onSelectField ? "group" : "img"}
      aria-label={title}
    >
      <title>{title}</title>
      {items.filter(p=>!hiddenTextId || p.kind!=="text" || p.blockId!==hiddenTextId).map((p, i) =>
        p.kind === "rect" ? (
          <rect
            key={i}
            x={p.x}
            y={p.y}
            width={p.w}
            height={p.h}
            fill={p.color}
          />
        ) : p.kind === "text" ? (
          <text
            key={i}
            role={onSelectField && p.editField ? "button" : undefined}
            tabIndex={onSelectField && p.editField ? 0 : undefined}
            aria-label={onSelectField && p.editField ? `Редактировать: ${p.text}` : undefined}
            aria-pressed={onSelectField && p.editField ? selectedField === p.editField : undefined}
            className={onSelectField && p.editField ? "slide-edit-target" : undefined}
            style={{fontFamily: p.font ? textStyle(p).family : undefined, fontFeatureSettings: p.font ? '"tnum", "kern"' : undefined, textDecoration: selectedField === p.editField && onSelectField ? "underline" : undefined}}
            onClick={onSelectField && p.editField ? () => onSelectField(p.editField!) : undefined}
            onKeyDown={onSelectField && p.editField ? e => { if(e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectField(p.editField!); } } : undefined}
            x={p.x}
            y={p.y + textStyle(p).baseline}
            fontSize={p.size}
            fontFamily={p.font ? textStyle(p).family : undefined}
            fontWeight={textStyle(p).weight}
            letterSpacing={p.font ? textStyle(p).spacing : undefined}
            xmlSpace={p.font ? "preserve" : undefined}
            fill={p.color}
          >
            {p.text}
          </text>
        ) : p.frame ? (()=>{
          const {viewport:v,source:s}=imagePlacement(p,p.frame);
          return <svg key={i} x={v.x} y={v.y} width={v.w} height={v.h} viewBox={`${s.x} ${s.y} ${s.w} ${s.h}`} preserveAspectRatio="none" overflow="hidden">
            <image href={imageUrl(p.assetId)} onError={onImageError} width={p.frame.sourceWidth} height={p.frame.sourceHeight}/>
          </svg>;
        })() : (
          <image
            key={i}
            href={imageUrl(p.assetId)} onError={onImageError}
            x={p.x}
            y={p.y}
            width={p.w}
            height={p.h}
            preserveAspectRatio="xMidYMid meet"
          />
        ),
      )}
    </svg>
  );
}
