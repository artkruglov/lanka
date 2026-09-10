import {z} from 'zod';
import type {Source} from './model';
import {canonicalJson} from './canonical-json';
import {sourceExtractionSchema} from './source-extraction';
const hash=z.string().regex(/^[a-f0-9]{64}$/);
/** Exact, bounded text consent. No original bytes, image metadata or implicit truncation. */
export function documentSourceValue(source:Source){
 if(source.kind==='image')throw Error('Разрешение на текст не открывает изображения.');
 const extraction=source.extraction?sourceExtractionSchema.parse(source.extraction):undefined;
 if(extraction&&!['extracted','partial'].includes(extraction.status))throw Error('Источник не прочитан.');
 if(!(extraction?.fragments.some(f=>f.text.trim())||source.excerpt.trim()))throw Error('В источнике нет доступного текста.');
 const value={id:source.id,name:source.name,kind:source.kind,sha256:hash.parse(source.sha256),contentType:source.contentType,excerpt:source.excerpt,...(extraction?{extraction}:{})};
 const text=canonicalJson(value);if(new TextEncoder().encode(text).byteLength>32_000)throw Error('Текст источника превышает 32 КБ. Подготовьте меньший материал.');
 return value;
}
