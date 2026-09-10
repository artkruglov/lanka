import type {CanvasElement} from './model';
import type {ObjectBox} from './data-layout';
import {initialObjectPlacement} from './object-placement';

/** Find room for a new image without moving existing content or producing a tiny thumbnail. */
export function initialImagePlacement(objects:CanvasElement[]):ObjectBox|undefined {
  return initialObjectPlacement(objects,[800,640,480,320].map(w=>({w,h:w*9/16})));
}
export const imagePlacementUnavailable='Для изображения нет свободного места. Добавьте новый слайд или освободите место на этом. Слайд не изменён.';

export class ImagePlacementError extends Error {constructor(){super(imagePlacementUnavailable);this.name='ImagePlacementError';}}
